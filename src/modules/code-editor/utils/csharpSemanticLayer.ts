import { StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap, showPanel } from '@codemirror/view';
import type { DecorationSet, Panel, ViewUpdate } from '@codemirror/view';

import { api, readApiJson } from '@/shared/api';
import type { CodeEditorLookup, CsharpLocation } from '@/shared/types';

type CsharpStatus = {
  state: 'starting' | 'loading' | 'ready' | 'failed' | 'unavailable' | 'notInstalled';
  solutionPath: string | null;
  message: string | null;
  // Goes up when Roslyn says earlier tokens are out of date, such as when analysis still partial at load completes.
  semanticRevision: number;
};

type CsharpSemanticToken = { line: number; character: number; length: number; type: string };

type CsharpSemanticResult<TValue> = { status: CsharpStatus; result: TValue | null };

type CsharpSemanticLabels = {
  loading: (solutionName: string) => string;
  findingDefinition: string;
  findingReferences: string;
  noDefinition: string;
  noReferences: string;
  definitions: (count: number) => string;
  references: (count: number) => string;
  openSettings: string;
};

type CsharpSemanticOptions = {
  filePath: string;
  // Opens another file at a 1-based line and 0-based character. A location in the open file moves the cursor instead.
  onOpenLocation: (filePath: string, line: number, character: number) => void;
  // Shows a lookup in the editor's lookup panel, which lives outside this file's view so it outlasts opening a result.
  onLookup: (lookup: CodeEditorLookup | null) => void;
  // Closes the lookup panel; returns whether one was open, so Escape falls through to the editor otherwise.
  onCloseLookup: () => boolean;
  // Opens the settings tab that installs the language server.
  onOpenSettings: () => void;
  labels: CsharpSemanticLabels;
};

const STATUS_POLL_INTERVAL_MS = 2000;
// Once loaded, the status is still polled now and then, to notice Roslyn asking for fresh tokens.
const READY_POLL_INTERVAL_MS = 4000;
// Without a server the status is still polled now and then, so installing one from settings takes effect by itself.
const NOT_INSTALLED_POLL_INTERVAL_MS = 5000;
const TOKEN_REFRESH_DELAY_MS = 600;

// Visual Studio 2022 colors per Roslyn token type, dark then light. Keywords, strings, comments and numbers
// stay with the syntactic layer, which colors them without waiting for the server.
const SEMANTIC_COLORS: Record<string, [string, string]> = {
  class: ['#4EC9B0', '#2B91AF'],
  recordClass: ['#4EC9B0', '#2B91AF'],
  delegate: ['#4EC9B0', '#2B91AF'],
  type: ['#4EC9B0', '#2B91AF'],
  struct: ['#86C691', '#2B91AF'],
  recordStruct: ['#86C691', '#2B91AF'],
  interface: ['#B8D7A3', '#2B91AF'],
  enum: ['#B8D7A3', '#2B91AF'],
  typeParameter: ['#B8D7A3', '#2B91AF'],
  method: ['#DCDCAA', '#74531F'],
  extensionMethod: ['#DCDCAA', '#74531F'],
  function: ['#DCDCAA', '#74531F'],
  parameter: ['#9CDCFE', '#1F377F'],
  variable: ['#9CDCFE', '#1F377F'],
  property: ['#DCDCDC', '#000000'],
  field: ['#DCDCDC', '#000000'],
  event: ['#DCDCDC', '#000000'],
  enumMember: ['#DCDCDC', '#000000'],
  namespace: ['#DCDCDC', '#000000'],
  label: ['#C8C8C8', '#000000'],
  excludedCode: ['#808080', '#808080'],
};

const semanticMarks = Object.fromEntries(
  Object.keys(SEMANTIC_COLORS).map((type) => [type, Decoration.mark({ class: `cm-csharp-${type}` })]),
);

const setSemanticDecorations = StateEffect.define<DecorationSet>();
const setStatus = StateEffect.define<CsharpStatus>();

function tokensToDecorations(doc: Text, tokens: CsharpSemanticToken[]): DecorationSet {
  const ranges = [];
  for (const token of tokens) {
    const mark = semanticMarks[token.type];
    if (!mark || token.line >= doc.lines) continue;
    const line = doc.line(token.line + 1);
    const from = line.from + token.character;
    const to = Math.min(from + token.length, line.to);
    if (from < to) ranges.push(mark.range(from, to));
  }
  return Decoration.set(ranges, true);
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

// Windows paths compare case-insensitively and may arrive with either slash.
function isSameFile(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function createSpinner(): HTMLElement {
  const spinner = document.createElement('span');
  spinner.className = 'cm-csharp-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  return spinner;
}

/**
 * Builds the semantic C# layer for one open `.cs` file: Roslyn's classification painted over the syntactic
 * colors, F12 / Ctrl+click for go to definition and Shift+F12 for find all references. Used by CodeEditor,
 * which adds it only for C# files. A spinning status bar under the file shows while the solution loads.
 */
export function createCsharpSemanticExtension({ filePath, onOpenLocation, onLookup, onCloseLookup, onOpenSettings, labels }: CsharpSemanticOptions): Extension {
  const semanticDecorations = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(decorations, transaction) {
      for (const effect of transaction.effects) if (effect.is(setSemanticDecorations)) return effect.value;
      return decorations.map(transaction.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
  });

  const statusField = StateField.define<CsharpStatus | null>({
    create: () => null,
    update(status, transaction) {
      for (const effect of transaction.effects) if (effect.is(setStatus)) return effect.value;
      return status;
    },
    provide: (field) => showPanel.from(field, (status) => {
      if (!status) return null;
      const isLoading = status.state === 'starting' || status.state === 'loading';
      // A file outside any solution simply has no semantic layer; that needs no bar.
      const showsMessage = status.state === 'failed' || status.state === 'notInstalled' || (status.state === 'unavailable' && status.solutionPath !== null);
      if (!isLoading && !showsMessage) return null;
      return () => createStatusPanel(status, isLoading);
    }),
  });

  function createStatusPanel(status: CsharpStatus, isLoading: boolean): Panel {
    const dom = document.createElement('div');
    dom.className = isLoading ? 'cm-csharp-status' : 'cm-csharp-status cm-csharp-status-error';
    if (isLoading) {
      dom.append(createSpinner(), labels.loading(fileName(status.solutionPath ?? '')));
    } else {
      dom.textContent = status.message ?? status.state;
      if (status.state === 'notInstalled') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cm-csharp-status-action';
        button.textContent = labels.openSettings;
        button.addEventListener('click', onOpenSettings);
        dom.append(button);
      }
    }
    return { dom, top: false };
  }

  function openLocation(view: EditorView, location: CsharpLocation): void {
    if (!isSameFile(location.filePath, filePath)) {
      onOpenLocation(location.filePath, location.line + 1, location.character);
      return;
    }
    const line = view.state.doc.line(Math.min(location.line + 1, view.state.doc.lines));
    const position = Math.min(line.from + location.character, line.to);
    view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    view.focus();
  }

  function caretPosition(state: EditorState): { line: number; character: number } {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    return { line: line.number - 1, character: head - line.from };
  }

  async function runLookup(view: EditorView, kind: 'definition' | 'references'): Promise<void> {
    const { line, character } = caretPosition(view.state);
    const text = view.state.doc.toString();
    onLookup({ kind: 'searching', text: kind === 'definition' ? labels.findingDefinition : labels.findingReferences });

    let lookup: CsharpSemanticResult<CsharpLocation[]>;
    try {
      const response = kind === 'definition'
        ? await api.csharpLanguage.definition(filePath, text, line, character)
        : await api.csharpLanguage.references(filePath, text, line, character);
      lookup = (await readApiJson<{ data: CsharpSemanticResult<CsharpLocation[]> }>(response)).data;
    } catch (error) {
      onLookup({ kind: 'message', text: error instanceof Error ? error.message : String(error) });
      return;
    }

    // Still loading: the status bar already says so, and the lookup can be repeated once it is gone.
    if (!lookup.result) {
      view.dispatch({ effects: setStatus.of(lookup.status) });
      onLookup(null);
      return;
    }

    const locations = lookup.result;
    if (locations.length === 0) {
      onLookup({ kind: 'message', text: kind === 'definition' ? labels.noDefinition : labels.noReferences });
    } else if (kind === 'definition' && locations.length === 1) {
      onLookup(null);
      openLocation(view, locations[0]);
    } else {
      const title = kind === 'definition' ? labels.definitions(locations.length) : labels.references(locations.length);
      onLookup({ kind: 'locations', text: title, locations, showsAccess: kind === 'references' });
    }
  }

  // Polls the server's load state while the solution loads, then keeps the semantic colors in step with edits.
  const semanticLoader = ViewPlugin.fromClass(class {
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private destroyed = false;
    // The semantic revision the painted tokens were fetched at; null until the first tokens arrive.
    private paintedRevision: number | null = null;

    constructor(private readonly view: EditorView) {
      void this.pollStatus();
    }

    update(update: ViewUpdate): void {
      if (!update.docChanged || update.state.field(statusField)?.state !== 'ready') return;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => void this.refreshTokens(), TOKEN_REFRESH_DELAY_MS);
    }

    destroy(): void {
      this.destroyed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    }

    private applyStatus(status: CsharpStatus): void {
      if (this.destroyed) return;
      const shown = this.view.state.field(statusField);
      if (shown?.state !== status.state || shown.message !== status.message || shown.solutionPath !== status.solutionPath) {
        this.view.dispatch({ effects: setStatus.of(status) });
      }
      if (status.state === 'starting' || status.state === 'loading') {
        this.pollTimer = setTimeout(() => void this.pollStatus(), STATUS_POLL_INTERVAL_MS);
      } else if (status.state === 'ready') {
        if (status.semanticRevision !== this.paintedRevision) void this.refreshTokens(status.semanticRevision);
        this.pollTimer = setTimeout(() => void this.pollStatus(), READY_POLL_INTERVAL_MS);
      } else if (status.state === 'notInstalled') {
        this.pollTimer = setTimeout(() => void this.pollStatus(), NOT_INSTALLED_POLL_INTERVAL_MS);
      }
    }

    private reportFailure(error: unknown): void {
      this.applyStatus({ state: 'failed', solutionPath: null, message: error instanceof Error ? error.message : String(error), semanticRevision: 0 });
    }

    private async pollStatus(): Promise<void> {
      try {
        const response = await api.csharpLanguage.status(filePath);
        this.applyStatus((await readApiJson<{ data: CsharpStatus }>(response)).data);
      } catch (error) {
        this.reportFailure(error);
      }
    }

    private async refreshTokens(revision = this.paintedRevision ?? 0): Promise<void> {
      const doc = this.view.state.doc;
      let tokens: CsharpSemanticResult<CsharpSemanticToken[]>;
      try {
        const response = await api.csharpLanguage.semanticTokens(filePath, doc.toString());
        tokens = (await readApiJson<{ data: CsharpSemanticResult<CsharpSemanticToken[]> }>(response)).data;
      } catch (error) {
        this.reportFailure(error);
        return;
      }
      // An edit made while the request ran has its own refresh scheduled; these tokens describe older text.
      if (this.destroyed || this.view.state.doc !== doc) return;
      if (!tokens.result) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.applyStatus(tokens.status);
        return;
      }
      this.paintedRevision = revision;
      this.view.dispatch({ effects: setSemanticDecorations.of(tokensToDecorations(doc, tokens.result)) });
    }
  });

  return [
    semanticDecorations,
    statusField,
    semanticLoader,
    keymap.of([
      { key: 'F12', run: (view) => { void runLookup(view, 'definition'); return true; } },
      { key: 'Shift-F12', run: (view) => { void runLookup(view, 'references'); return true; } },
      { key: 'Escape', run: () => onCloseLookup() },
    ]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false;
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position === null) return false;
        event.preventDefault();
        view.dispatch({ selection: { anchor: position } });
        void runLookup(view, 'definition');
        return true;
      },
    }),
    csharpSemanticTheme,
  ];
}

// The theme scope (`&dark` / `&light`) out-ranks the syntax highlighter's own classes, and the `*` covers a
// syntax span nested inside a semantic one.
const csharpSemanticTheme = EditorView.baseTheme({
  ...Object.fromEntries(Object.entries(SEMANTIC_COLORS).flatMap(([type, [dark, light]]) => [
    [`&dark .cm-csharp-${type}, &dark .cm-csharp-${type} *`, { color: dark }],
    [`&light .cm-csharp-${type}, &light .cm-csharp-${type} *`, { color: light }],
  ])),
  '@keyframes cm-csharp-spin': { to: { transform: 'rotate(360deg)' } },
  '.cm-csharp-spinner': {
    display: 'inline-block',
    flexShrink: '0',
    width: '10px',
    height: '10px',
    marginRight: '8px',
    border: '2px solid currentColor',
    borderTopColor: 'transparent',
    borderRadius: '50%',
    animation: 'cm-csharp-spin 0.8s linear infinite',
  },
  '.cm-csharp-status': {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 10px',
    fontSize: '12px',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  },
  '&dark .cm-csharp-status': { color: '#9ca3af' },
  '&light .cm-csharp-status': { color: '#4b5563' },
  '&dark .cm-csharp-status-error': { color: '#f87171' },
  '&light .cm-csharp-status-error': { color: '#b91c1c' },
  '.cm-csharp-status-action': {
    marginLeft: '10px',
    padding: '1px 8px',
    border: '1px solid currentColor',
    borderRadius: '4px',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    flexShrink: '0',
  },
  '.cm-csharp-status-action:hover': { backgroundColor: 'rgba(127, 127, 127, 0.15)' },
});
