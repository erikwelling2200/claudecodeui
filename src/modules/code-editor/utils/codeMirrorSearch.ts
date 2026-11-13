import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';

import { buildSearchPattern, expandReplacement, findTextMatches } from '@/modules/code-editor/utils/fileSearch';
import type { FileSearchProvider, FileSearchQuery, TextMatch } from '@/modules/code-editor/utils/fileSearch';

const setFindHighlights = StateEffect.define<{ matches: TextMatch[]; current: number }>();

const matchMark = Decoration.mark({ class: 'cm-file-find-match' });
const currentMark = Decoration.mark({ class: 'cm-file-find-current' });

const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setFindHighlights)) continue;
      const { matches, current } = effect.value;
      next = Decoration.set(matches.map((match, index) => (index === current ? currentMark : matchMark).range(match.from, match.to)));
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const findHighlightTheme = EditorView.baseTheme({
  '.cm-file-find-match': { backgroundColor: 'rgb(250 204 21 / 0.4)', borderRadius: '2px' },
  '.cm-file-find-current': { backgroundColor: 'rgb(249 115 22 / 0.75)', borderRadius: '2px', outline: '1px solid rgb(249 115 22)' },
});

/** The decoration layer the find bar paints into; part of every text editor so a provider can be built for any view. */
export const fileFindExtension: Extension = [findHighlightField, findHighlightTheme];

/** Searches the whole CodeMirror document, including lines scrolled out of the DOM, and edits it on replace. */
export const createCodeMirrorSearchProvider = (view: EditorView): FileSearchProvider => {
  let matches: TextMatch[] = [];
  let lastQuery: FileSearchQuery | null = null;

  const paint = (current: number) => view.dispatch({ effects: setFindHighlights.of({ matches, current }) });

  return {
    search: (query) => {
      lastQuery = query;
      const pattern = buildSearchPattern(query);
      matches = pattern ? findTextMatches(view.state.doc.toString(), pattern) : [];
      paint(-1);
      return matches.length;
    },
    reveal: (index, scroll) => {
      const match = matches[index];
      if (!match || !scroll) {
        paint(index);
        return;
      }
      view.dispatch({
        effects: [setFindHighlights.of({ matches, current: index }), EditorView.scrollIntoView(match.from, { y: 'center' })],
        selection: EditorSelection.single(match.from, match.to),
      });
    },
    getStartIndex: () => {
      const caret = view.state.selection.main.from;
      const index = matches.findIndex((match) => match.from >= caret);
      return index < 0 ? 0 : index;
    },
    replace: (index, replacement) => {
      const match = matches[index];
      if (!match || !lastQuery) return;
      const insert = expandReplacement(view.state.sliceDoc(match.from, match.to), lastQuery, replacement);
      view.dispatch({ changes: { from: match.from, to: match.to, insert }, selection: EditorSelection.cursor(match.from + insert.length) });
    },
    replaceAll: (replacement) => {
      if (matches.length === 0 || !lastQuery) return;
      const query = lastQuery;
      view.dispatch({
        changes: matches.map((match) => ({ from: match.from, to: match.to, insert: expandReplacement(view.state.sliceDoc(match.from, match.to), query, replacement) })),
      });
    },
    clear: () => {
      matches = [];
      // The view may already be destroyed when its tab or file closes.
      if (view.dom.isConnected) paint(-1);
    },
  };
};
