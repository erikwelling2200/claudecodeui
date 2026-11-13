import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { Prec } from '@codemirror/state';
import type { Extension } from '@codemirror/state';

import type { CodeEditorGotoTarget } from '@/shared/types';

import { createCodeMirrorSearchProvider, fileFindExtension } from '@/modules/code-editor/utils/codeMirrorSearch';
import { useFileSearchProvider } from '@/modules/code-editor/hooks/useFileSearchProvider';
import MarkdownPreview from '@/modules/code-editor/markdown/MarkdownPreview';
import CodeEditorCsvTable from '@/modules/code-editor/CodeEditorCsvTable';

// Visual Studio 2022's editor surface, to sit under the Visual Studio syntax colors: a neutral background, an
// outlined current line and its selection blue. In dark mode One Dark still colors languages without a VS palette.
const createVisualStudioSurface = (isDarkMode: boolean): Extension => {
  const colors = isDarkMode
    ? { background: '#1E1E1E', foreground: '#DCDCDC', panels: '#252526', currentLine: '#464646', selection: '#264F78', inactiveSelection: '#3A3D41', lineNumber: '#2B91AF', activeLineNumber: '#DCDCDC', cursor: '#DCDCDC' }
    : { background: '#FFFFFF', foreground: '#000000', panels: '#F5F5F5', currentLine: '#EAEAF2', selection: '#99C9EF', inactiveSelection: '#E5EBF1', lineNumber: '#2B91AF', activeLineNumber: '#000000', cursor: '#000000' };
  return Prec.highest(EditorView.theme({
    '&': { backgroundColor: colors.background, color: colors.foreground },
    '.cm-content': { caretColor: colors.cursor },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: colors.cursor },
    '.cm-gutters': { backgroundColor: colors.background, color: colors.lineNumber, border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: colors.activeLineNumber },
    '.cm-activeLine': { backgroundColor: 'transparent', boxShadow: `inset 0 0 0 2px ${colors.currentLine}` },
    '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: colors.inactiveSelection },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-content ::selection': {
      backgroundColor: colors.selection,
    },
    '.cm-panels': { backgroundColor: colors.panels, color: colors.foreground },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${colors.currentLine}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${colors.currentLine}` },
  }, { dark: isDarkMode }));
};

const DARK_THEME: Extension = [oneDark, createVisualStudioSurface(true)];
const LIGHT_THEME: Extension = createVisualStudioSurface(false);

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  markdownPreview: boolean;
  isMarkdownFile: boolean;
  // The CSV/TSV spreadsheet view replaces the text surface while on.
  csvTableView?: boolean;
  fileName?: string;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
  // Line to reveal once the document is loaded (`path:line` references).
  gotoTarget?: CodeEditorGotoTarget | null;
};

/** Rendered by CodeEditor inside the code-editor module to show the CodeMirror editing surface, the markdown preview or the CSV table. */
export default function CodeEditorSurface({
  content,
  onChange,
  markdownPreview,
  isMarkdownFile,
  csvTableView = false,
  fileName = '',
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
  gotoTarget = null,
}: CodeEditorSurfaceProps) {
  // Tracked as state, not a ref: the editor view is created after the first
  // render, and a ref would not re-run the effect once it lands.
  const [view, setView] = useState<EditorView | null>(null);

  // The last request already jumped to. `content` is the editor's own state and
  // changes on every keystroke, so without this the caret would be dragged back
  // to the requested line while the file is being edited.
  const jumpedToRef = useRef<CodeEditorGotoTarget | null>(null);

  // Content arrives asynchronously, so the jump waits for both the view and the
  // document; each request is then applied exactly once.
  useEffect(() => {
    if (!view || !gotoTarget || !content || jumpedToRef.current === gotoTarget) {
      return;
    }
    jumpedToRef.current = gotoTarget;
    const target = Math.min(Math.max(gotoTarget.line, 1), view.state.doc.lines);
    const line = view.state.doc.line(target);
    const position = Math.min(line.from + Math.max(gotoTarget.character ?? 0, 0), line.to);
    view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    });
  }, [view, gotoTarget, content]);

  const showsText = !csvTableView && !(markdownPreview && isMarkdownFile);
  // Rebuilt with the content so an open find bar recounts after every edit. The CSV table registers its own; the markdown
  // preview is searched by the frame as rendered text.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const searchProvider = useMemo(() => (view && showsText ? createCodeMirrorSearchProvider(view) : null), [content, showsText, view]);
  // The CodeMirror view unmounts behind the table and the preview; a fresh one arrives through onCreateEditor.
  useEffect(() => {
    if (!showsText) setView(null);
  }, [showsText]);
  useFileSearchProvider(searchProvider);
  const surfaceExtensions = useMemo(() => [...extensions, fileFindExtension], [extensions]);

  if (csvTableView) {
    return <CodeEditorCsvTable content={content} onChange={onChange} fileName={fileName} fontSize={fontSize} />;
  }

  if (markdownPreview && isMarkdownFile) {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
        <div className="prose prose-sm mx-auto max-w-4xl px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
          <MarkdownPreview content={content} />
        </div>
      </div>
    );
  }

  return (
    <CodeMirror
      onCreateEditor={setView}
      value={content}
      onChange={onChange}
      extensions={surfaceExtensions}
      theme={isDarkMode ? DARK_THEME : LIGHT_THEME}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        // The frame's find bar replaces CodeMirror's own search panel.
        searchKeymap: false,
      }}
    />
  );
}
