import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import type { Extension } from '@codemirror/state';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Code2, Eye, Table } from 'lucide-react';

import { usePaletteOps } from '@/modules/command-palette';
import { useTheme } from '@/shared/context/ThemeContext';
import { useCodeEditorDocument } from '@/modules/code-editor/hooks/useCodeEditorDocument';
import { useCodeEditorSettings } from '@/modules/code-editor/hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '@/modules/code-editor/hooks/useEditorKeyboardShortcuts';
import type { CodeEditorFile, CodeEditorGotoTarget, CodeEditorLookup } from '@/shared/types';
import { createMinimapExtension, createScrollToFirstChunkExtension, getLanguageExtensions } from '@/modules/code-editor/utils/editorExtensions';
import { createCsharpSemanticExtension } from '@/modules/code-editor/utils/csharpSemanticLayer';
import { getEditorStyles } from '@/modules/code-editor/utils/editorStyles';
import { createEditorToolbarPanelExtension } from '@/modules/code-editor/utils/editorToolbarPanel';
import { isCsvFileName } from '@/modules/code-editor/utils/csvDocument';
import CodeEditorFooter from '@/modules/code-editor/CodeEditorFooter';
import CodeEditorFrame from '@/modules/code-editor/CodeEditorFrame';
import CodeEditorHeaderActions from '@/modules/code-editor/CodeEditorHeaderActions';
import { headerButtonActiveClassName, headerButtonClassName } from '@/modules/code-editor/utils/headerActionsSlot';
import CodeEditorLoadingState from '@/modules/code-editor/CodeEditorLoadingState';
import CodeEditorSurface from '@/modules/code-editor/CodeEditorSurface';
import CodeEditorBinaryFile from '@/modules/code-editor/CodeEditorBinaryFile';
import CodeEditorMediaPreview from '@/modules/code-editor/CodeEditorMediaPreview';

type CodeEditorProps = {
  file: CodeEditorFile;
  // Reports whether the buffer differs from the file on disk, so the owner can
  // guard replacing this editor with another file the same way closing is.
  onUnsavedChangesChange?: (hasUnsavedChanges: boolean) => void;
  projectPath?: string;
  isSidebar?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
  // Opens another file at a 1-based line and 0-based character; go to definition and find references use it to leave this file.
  onOpenLocation?: (filePath: string, line: number, character: number) => void;
  // The line to reveal; a new object per request, so the same line can be asked for twice.
  gotoTarget?: CodeEditorGotoTarget | null;
  // Only the visible tab answers the document-wide Ctrl+S; hidden tabs stay mounted to keep their buffers.
  isActive?: boolean;
  // The open-file tabs, drawn above this file's header in every layout.
  tabStrip?: ReactNode;
  // The C# lookup panel, drawn under the text; owned by EditorSidebar so it outlasts switching files.
  lookupPanel?: ReactNode;
  onLookup?: (lookup: CodeEditorLookup | null) => void;
  onCloseLookup?: () => boolean;
};

/** Rendered by the code-editor module's own EditorSidebar, and re-exported on the module barrel, as the full CodeMirror editor for one open file. */
export default function CodeEditor({
  file,
  onUnsavedChangesChange,
  projectPath,
  isSidebar = false,
  isExpanded = false,
  onToggleExpand = null,
  onPopOut = null,
  onOpenLocation,
  gotoTarget = null,
  isActive = true,
  tabStrip = null,
  lookupPanel = null,
  onLookup,
  onCloseLookup,
}: CodeEditorProps) {
  const { t } = useTranslation('codeEditor');
  const paletteOps = usePaletteOps();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDiff, setShowDiff] = useState(Boolean(file.diffInfo));
  const [markdownPreview, setMarkdownPreview] = useState(false);
  const isCsvFile = isCsvFileName(file.name);
  // CSV opens as a table, except when it was opened to show a diff, which only the text view can draw.
  const [csvTableView, setCsvTableView] = useState(() => isCsvFile && !file.diffInfo);

  // The code editor follows the app-wide theme; it has no theme of its own.
  const { isDarkMode } = useTheme();

  const {
    wordWrap,
    minimapEnabled,
    showLineNumbers,
    fontSize,
  } = useCodeEditorSettings();

  const {
    content,
    setContent,
    loading,
    saveError,
    isBinary,
    previewKind,
    fileProjectId,
    hasUnsavedChanges,
    handleSave,
  } = useCodeEditorDocument({
    file,
    projectPath,
  });

  // Cleared on unmount so a closed editor can never block the next open.
  useEffect(() => {
    onUnsavedChangesChange?.(hasUnsavedChanges);
    return () => onUnsavedChangesChange?.(false);
  }, [hasUnsavedChanges, onUnsavedChangesChange]);

  // The browser only shows its leave-page prompt while a listener is attached,
  // so one is registered for exactly as long as there is something to lose.
  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy trigger for browsers that ignore preventDefault() here (Chrome/Edge < 119).
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges]);

  const isMarkdownFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'md' || extension === 'markdown';
  }, [file.name]);

  const isHtmlPreviewFile = useMemo(() => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    return extension === 'html' || extension === 'htm';
  }, [file.name]);

  const openHtmlPreview = useCallback(() => {
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) return;

    previewWindow.opener = null;
    previewWindow.document.title = file.name;
    previewWindow.document.body.style.margin = '0';

    const iframe = previewWindow.document.createElement('iframe');
    iframe.title = file.name;
    iframe.sandbox.add('allow-forms', 'allow-modals', 'allow-popups', 'allow-scripts');
    iframe.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:white';

    iframe.srcdoc = content;

    previewWindow.document.body.appendChild(iframe);
  }, [content, file.name]);

  const minimapExtension = useMemo(
    () => (
      createMinimapExtension({
        file,
        showDiff,
        minimapEnabled,
        isDarkMode,
      })
    ),
    [file, isDarkMode, minimapEnabled, showDiff],
  );

  const scrollToFirstChunkExtension = useMemo(
    () => createScrollToFirstChunkExtension({ file, showDiff }),
    [file, showDiff],
  );

  const toolbarPanelExtension = useMemo(
    () => (
      createEditorToolbarPanelExtension({
        file,
        showDiff,
        onToggleDiff: () => setShowDiff((previous) => !previous),
        labels: {
          changes: t('toolbar.changes'),
          previousChange: t('toolbar.previousChange'),
          nextChange: t('toolbar.nextChange'),
          hideDiff: t('toolbar.hideDiff'),
          showDiff: t('toolbar.showDiff'),
        },
      })
    ),
    [file, showDiff, t],
  );

  // The Roslyn-backed layer for C#: semantic colors, F12 and Shift+F12. It needs an absolute path to find the solution.
  const csharpSemanticExtension = useMemo(() => {
    if (!onOpenLocation || !onLookup || !onCloseLookup || file.name.split('.').pop()?.toLowerCase() !== 'cs') return null;
    const isAbsolutePath = /^([a-zA-Z]:[\\/]|[\\/])/.test(file.path);
    const absolutePath = isAbsolutePath || !projectPath ? file.path : `${projectPath.replace(/[\\/]+$/, '')}/${file.path}`;
    return createCsharpSemanticExtension({
      filePath: absolutePath,
      onOpenLocation,
      onLookup,
      onCloseLookup,
      onOpenSettings: () => paletteOps.openSettings('languages'),
      labels: {
        loading: (solutionName) => t('csharp.loading', 'Loading {{solutionName}}', { solutionName }),
        findingDefinition: t('csharp.findingDefinition', 'Finding definition'),
        findingReferences: t('csharp.findingReferences', 'Finding references'),
        noDefinition: t('csharp.noDefinition', 'No definition found'),
        noReferences: t('csharp.noReferences', 'No references found'),
        definitions: (count) => t('csharp.definitions', '{{count}} definitions', { count }),
        references: (count) => t('csharp.references', '{{count}} references', { count }),
        openSettings: t('csharp.openSettings', 'Install in Settings'),
      },
    });
  }, [file.name, file.path, onCloseLookup, onLookup, onOpenLocation, paletteOps, projectPath, t]);

  const extensions = useMemo(() => {
    const allExtensions: Extension[] = [
      ...getLanguageExtensions(file.name),
      ...toolbarPanelExtension,
    ];

    if (csharpSemanticExtension) {
      allExtensions.push(csharpSemanticExtension);
    }

    if (file.diffInfo && showDiff && file.diffInfo.old_string !== undefined) {
      allExtensions.push(
        unifiedMergeView({
          original: file.diffInfo.old_string,
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          gutter: true,
        }),
      );
      allExtensions.push(...minimapExtension);
      allExtensions.push(...scrollToFirstChunkExtension);
    }

    if (wordWrap) {
      allExtensions.push(EditorView.lineWrapping);
    }

    return allExtensions;
  }, [
    csharpSemanticExtension,
    file.diffInfo,
    file.name,
    minimapExtension,
    scrollToFirstChunkExtension,
    showDiff,
    toolbarPanelExtension,
    wordWrap,
  ]);

  useEditorKeyboardShortcuts({
    onSave: handleSave,
    dependency: content,
    enabled: isActive,
  });

  if (loading) {
    const loadingState = (
      <CodeEditorLoadingState
        isDarkMode={isDarkMode}
        isSidebar={isSidebar}
        loadingText={t('loading', { fileName: file.name })}
      />
    );
    // Docked, the tabs stay in place while a file loads; floating, the loading box stands alone for that moment.
    return isSidebar && tabStrip ? (
      <div className="flex h-full w-full flex-col">
        {tabStrip}
        <div className="min-h-0 flex-1">{loadingState}</div>
      </div>
    ) : loadingState;
  }

  const frameProps = {
    file,
    tabStrip,
    isSidebar,
    isExpanded,
    isFullscreen,
    onToggleExpand,
    onPopOut,
    onToggleFullscreen: () => setIsFullscreen((previous) => !previous),
  };

  // Natively previewable media (image/pdf/audio/video) is rendered inline
  // instead of showing the generic "cannot be displayed" placeholder.
  if (previewKind) {
    return (
      <CodeEditorFrame {...frameProps}>
        <CodeEditorMediaPreview
          file={file}
          kind={previewKind}
          projectId={fileProjectId}
          labels={{
            loading: t('filePreview.loading', 'Loading preview...'),
            error: t('filePreview.error', 'Unable to display this file.'),
            openInNewTab: t('filePreview.openInNewTab', 'Open in new tab'),
          }}
        />
      </CodeEditorFrame>
    );
  }

  if (isBinary) {
    return (
      <CodeEditorFrame {...frameProps}>
        <CodeEditorBinaryFile
          title={t('binaryFile.title', 'Binary File')}
          message={t('binaryFile.message', 'The file "{{fileName}}" cannot be displayed in the text editor because it is a binary file.', { fileName: file.name })}
        />
      </CodeEditorFrame>
    );
  }

  return (
    <>
      <style>{getEditorStyles(isDarkMode)}</style>
      <CodeEditorFrame {...frameProps} hasUnsavedChanges={hasUnsavedChanges}>
        <CodeEditorHeaderActions>
          {isMarkdownFile && (
            <button
              type="button"
              onClick={() => setMarkdownPreview((previous) => !previous)}
              className={markdownPreview ? headerButtonActiveClassName : headerButtonClassName}
              title={markdownPreview ? t('actions.editMarkdown') : t('actions.previewMarkdown')}
            >
              {markdownPreview ? <Code2 className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
          {isCsvFile && (
            <button
              type="button"
              onClick={() => setCsvTableView((previous) => !previous)}
              className={csvTableView ? headerButtonActiveClassName : headerButtonClassName}
              title={csvTableView ? t('actions.showCsvText', 'Show as text') : t('actions.showCsvTable', 'Show as table')}
            >
              {csvTableView ? <Code2 className="h-4 w-4" /> : <Table className="h-4 w-4" />}
            </button>
          )}
          {isHtmlPreviewFile && (
            <button type="button" onClick={openHtmlPreview} className={headerButtonClassName} title={t('actions.previewHtml', 'Open HTML preview in new tab')}>
              <Eye className="h-4 w-4" />
            </button>
          )}
        </CodeEditorHeaderActions>

        {saveError && (
          <div className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
            {saveError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeEditorSurface
            content={content}
            onChange={setContent}
            markdownPreview={markdownPreview}
            isMarkdownFile={isMarkdownFile}
            csvTableView={csvTableView && isCsvFile}
            fileName={file.name}
            isDarkMode={isDarkMode}
            fontSize={fontSize}
            showLineNumbers={showLineNumbers}
            extensions={extensions}
            gotoTarget={gotoTarget}
          />
        </div>

        {lookupPanel}

        <CodeEditorFooter
          content={content}
          linesLabel={t('footer.lines')}
          charactersLabel={t('footer.characters')}
          shortcutsLabel={t('footer.shortcuts')}
        />
      </CodeEditorFrame>
    </>
  );
}
