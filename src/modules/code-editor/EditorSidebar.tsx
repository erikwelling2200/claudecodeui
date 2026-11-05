import { memo, useCallback, useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRightOpen } from 'lucide-react';

import type { CodeEditorLookup, CodeEditorTab, CsharpLocation } from '@/shared/types';
import CodeEditor from '@/modules/code-editor/CodeEditor';
import CodeEditorLookupPanel from '@/modules/code-editor/CodeEditorLookupPanel';
import CodeEditorTabs from '@/modules/code-editor/CodeEditorTabs';

type EditorSidebarProps = {
  tabs: CodeEditorTab[];
  activeTabKey: string | null;
  dirtyTabKeys: ReadonlySet<string>;
  isMobile: boolean;
  editorExpanded: boolean;
  // Docked only: the panel shrinks to a rail with a show button, its tabs kept mounted.
  editorHidden: boolean;
  editorWidth: number;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onActivateTab: (tabKey: string) => void;
  // Closes without asking; this component confirms a dirty tab first.
  onCloseTab: (tabKey: string) => void;
  onToggleEditorExpand: () => void;
  onToggleEditorHidden: () => void;
  // Reported per tab, so the tab strip can mark dirty files and closing one can ask first.
  onUnsavedChangesChange: (tabKey: string, hasUnsavedChanges: boolean) => void;
  projectPath?: string;
  // Forwarded to CodeEditor so go to definition and find references can open a file at a line and character.
  onOpenLocation?: (filePath: string, line: number, character: number) => void;
};

type EditorTabPaneProps = {
  tab: CodeEditorTab;
  isActive: boolean;
  isFloating: boolean;
  editorExpanded: boolean;
  // Only the active tab gets these; null for the rest keeps their memoised props unchanged.
  tabStrip: ReactNode;
  lookupPanel: ReactNode;
  projectPath?: string;
  onCloseTab: (tabKey: string) => void;
  onUnsavedChangesChange: (tabKey: string, hasUnsavedChanges: boolean) => void;
  onToggleEditorExpand: () => void;
  onPopOut: () => void;
  onOpenLocation?: (filePath: string, line: number, character: number) => void;
  onLookup: (lookup: CodeEditorLookup | null) => void;
  onCloseLookup: () => boolean;
};

// One mounted editor per tab. Hidden tabs stay mounted so their buffers, undo history and scroll position
// survive switching; memoised so typing in one tab does not re-render the others.
const EditorTabPane = memo(function EditorTabPane({
  tab,
  isActive,
  isFloating,
  editorExpanded,
  tabStrip,
  lookupPanel,
  projectPath,
  onCloseTab,
  onUnsavedChangesChange,
  onToggleEditorExpand,
  onPopOut,
  onOpenLocation,
  onLookup,
  onCloseLookup,
}: EditorTabPaneProps) {
  const { key } = tab;
  const handleClose = useCallback(() => onCloseTab(key), [key, onCloseTab]);
  const handleUnsavedChangesChange = useCallback(
    (hasUnsavedChanges: boolean) => onUnsavedChangesChange(key, hasUnsavedChanges),
    [key, onUnsavedChangesChange],
  );

  return (
    <div className={isActive ? 'contents' : 'hidden'}>
      <CodeEditor
        file={tab.file}
        gotoTarget={tab.gotoTarget}
        isActive={isActive}
        onClose={handleClose}
        onUnsavedChangesChange={handleUnsavedChangesChange}
        projectPath={projectPath}
        isSidebar={!isFloating}
        isExpanded={!isFloating && editorExpanded}
        onToggleExpand={isFloating ? null : onToggleEditorExpand}
        onPopOut={isFloating ? null : onPopOut}
        onOpenLocation={onOpenLocation}
        onLookup={onLookup}
        onCloseLookup={onCloseLookup}
        tabStrip={tabStrip}
        lookupPanel={lookupPanel}
      />
    </div>
  );
});

// Minimum width for the left content (file tree, chat, etc.)
const MIN_LEFT_CONTENT_WIDTH = 200;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;

/** Used by the project-workspace module to dock the code editor beside the workspace content, with drag-to-resize and pop-out behaviour. */
export default function EditorSidebar({
  tabs,
  activeTabKey,
  dirtyTabKeys,
  isMobile,
  editorExpanded,
  editorHidden,
  editorWidth,
  resizeHandleRef,
  onResizeStart,
  onActivateTab,
  onCloseTab,
  onToggleEditorExpand,
  onToggleEditorHidden,
  onUnsavedChangesChange,
  projectPath,
  onOpenLocation,
}: EditorSidebarProps) {
  const { t } = useTranslation('codeEditor');
  const [poppedOut, setPoppedOut] = useState(false);
  const [lookup, setLookup] = useState<CodeEditorLookup | null>(null);
  const hasTabs = tabs.length > 0;
  const containerRef = useRef<HTMLDivElement>(null);
  // Only the ceiling is state; the applied width is derived below. Holding a
  // second copy of the width meant every drag frame rendered twice, and keeping
  // `editorWidth` in this effect's dependencies rebuilt the ResizeObserver on
  // every one of those frames.
  const [maxEditorWidth, setMaxEditorWidth] = useState<number | null>(null);

  // Track how much room the container can spare so the left content keeps at
  // least MIN_LEFT_CONTENT_WIDTH as the window resizes.
  useEffect(() => {
    if (!hasTabs || isMobile || poppedOut || editorHidden) return;

    const updateAvailableWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      const availableWidth = parentElement.clientWidth - MIN_LEFT_CONTENT_WIDTH;

      if (availableWidth < MIN_EDITOR_WIDTH) {
        // Not enough space - pop out the editor so user can still see everything
        setPoppedOut(true);
        return;
      }

      setMaxEditorWidth(availableWidth);
    };

    updateAvailableWidth();
    window.addEventListener('resize', updateAvailableWidth);

    // Also use ResizeObserver for more accurate detection
    const resizeObserver = new ResizeObserver(updateAvailableWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }

    return () => {
      window.removeEventListener('resize', updateAvailableWidth);
      resizeObserver.disconnect();
    };
  }, [hasTabs, isMobile, poppedOut, editorHidden]);

  const effectiveWidth = maxEditorWidth === null
    ? editorWidth
    : Math.min(editorWidth, maxEditorWidth);

  // Closing the last tab leaves the floating layout and the lookup behind, so the next file opens docked again.
  // Stable identities keep the editors' keyboard shortcuts and C# layers from being rebuilt on every render.
  // Mirrors read by the stable callbacks below without re-creating them on every change.
  const tabCountRef = useRef(tabs.length);
  const dirtyTabKeysRef = useRef(dirtyTabKeys);
  const lookupRef = useRef(lookup);
  useEffect(() => {
    tabCountRef.current = tabs.length;
    dirtyTabKeysRef.current = dirtyTabKeys;
    lookupRef.current = lookup;
  }, [tabs.length, dirtyTabKeys, lookup]);

  const handleCloseTab = useCallback((tabKey: string) => {
    if (tabCountRef.current === 1) {
      setPoppedOut(false);
      setLookup(null);
    }
    onCloseTab(tabKey);
  }, [onCloseTab]);

  // The tab strip's close asks here, for any tab; the editor's own close button asks in CodeEditor.
  const handleRequestCloseTab = useCallback((tabKey: string) => {
    // No inline fallback here on purpose: CodeEditor's `requestClose` owns the one for this key.
    if (dirtyTabKeysRef.current.has(tabKey) && !window.confirm(t('unsavedChanges.confirmClose'))) return;
    handleCloseTab(tabKey);
  }, [handleCloseTab, t]);

  const handlePopOut = useCallback(() => setPoppedOut(true), []);

  const handleCloseLookup = useCallback(() => {
    if (!lookupRef.current) return false;
    setLookup(null);
    return true;
  }, []);

  const handleOpenLookupLocation = useCallback((location: CsharpLocation) => {
    onOpenLocation?.(location.filePath, location.line + 1, location.character);
  }, [onOpenLocation]);

  if (!hasTabs) {
    return null;
  }

  // One CodeEditor element per tab, each in one position for every layout; only the wrappers
  // change, so switching layouts never remounts it and drops the buffer.
  const isFloating = isMobile || poppedOut;
  const isHidden = editorHidden && !isFloating;

  const tabStrip = (
    <CodeEditorTabs
      tabs={tabs}
      activeTabKey={activeTabKey}
      dirtyTabKeys={dirtyTabKeys}
      onActivateTab={onActivateTab}
      onRequestCloseTab={handleRequestCloseTab}
      onHide={isFloating ? null : onToggleEditorHidden}
    />
  );

  const lookupPanel = lookup && (
    <CodeEditorLookupPanel lookup={lookup} onOpenLocation={handleOpenLookupLocation} onClose={handleCloseLookup} />
  );

  // Docked, the panel always has the one width the divider sets, whatever the main view or the open tab; a
  // flexible width would be sized partly by the active tab's content and change from tab to tab. Only the
  // expanded editor, which hides the main view, takes the whole row.
  const useFlexLayout = editorExpanded;

  // The resize handle sits in a fixed child slot, so dropping it never shifts
  // the editor's position and remounts it. `contents` makes the wrappers give
  // up their own boxes while the floating editor covers the viewport by itself.
  return (
    <div
      ref={containerRef}
      className={isFloating ? 'contents' : `flex h-full min-w-0 ${editorExpanded ? 'flex-1' : ''}`}
    >
      {isHidden && (
        <div className="flex h-full w-12 flex-shrink-0 flex-col items-center border-l border-border/50 bg-background/80 py-3">
          <button
            type="button"
            onClick={onToggleEditorHidden}
            className="group flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-accent/80"
            aria-label={t('tabs.showEditor')}
            title={t('tabs.showEditor')}
          >
            <PanelRightOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
          </button>
        </div>
      )}

      {!isFloating && !isHidden && !editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-500 dark:bg-gray-700 dark:hover:bg-blue-600"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-blue-600" />
        </div>
      )}

      <div
        className={isFloating
          ? 'contents'
          : isHidden
            ? 'hidden'
            : `h-full overflow-hidden border-l border-gray-200 dark:border-gray-700 ${useFlexLayout ? 'min-w-0 flex-1' : ''}`}
        style={isFloating || useFlexLayout ? undefined : { width: `${effectiveWidth}px`, minWidth: `${MIN_EDITOR_WIDTH}px` }}
      >
        {tabs.map((tab) => (
          <EditorTabPane
            key={tab.key}
            tab={tab}
            isActive={tab.key === activeTabKey}
            isFloating={isFloating}
            editorExpanded={editorExpanded}
            tabStrip={tab.key === activeTabKey ? tabStrip : null}
            lookupPanel={tab.key === activeTabKey ? lookupPanel : null}
            projectPath={projectPath}
            onCloseTab={handleCloseTab}
            onUnsavedChangesChange={onUnsavedChangesChange}
            onToggleEditorExpand={onToggleEditorExpand}
            onPopOut={handlePopOut}
            onOpenLocation={onOpenLocation}
            onLookup={setLookup}
            onCloseLookup={handleCloseLookup}
          />
        ))}
      </div>
    </div>
  );
}
