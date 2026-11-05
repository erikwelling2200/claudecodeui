import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { CodeEditorDiffInfo, CodeEditorFile, CodeEditorTab, Project } from '@/shared/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

// One key per file per project, so the same file opened by a relative and an absolute path, or with either
// slash, lands in one tab. Windows paths compare case-insensitively.
const getTabKey = (filePath: string, projectId: string | undefined, projectPath: string | undefined) => {
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(filePath);
  const absolutePath = isAbsolute || !projectPath ? filePath : `${projectPath.replace(/[\\/]+$/, '')}/${filePath}`;
  const normalizedPath = absolutePath.replace(/\\/g, '/');
  return `${projectId ?? ''}|${/^[a-zA-Z]:\//.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath}`;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const { t } = useTranslation('codeEditor');
  const [tabs, setTabs] = useState<CodeEditorTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null);
  const [dirtyTabKeys, setDirtyTabKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  // The tabs and their dirtiness, mirrored so `handleFileOpen` can read them without re-creating itself on
  // every change, which keeps it stable for the memoised chat and tree consumers.
  const tabsRef = useRef<CodeEditorTab[]>([]);
  const dirtyTabKeysRef = useRef<ReadonlySet<string>>(dirtyTabKeys);
  const activeTabKeyRef = useRef<string | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
    dirtyTabKeysRef.current = dirtyTabKeys;
    activeTabKeyRef.current = activeTabKey;
  }, [tabs, dirtyTabKeys, activeTabKey]);

  const editingFile = tabs.find((tab) => tab.key === activeTabKey)?.file ?? null;

  const handleUnsavedChangesChange = useCallback((tabKey: string, hasUnsavedChanges: boolean) => {
    setDirtyTabKeys((previous) => {
      if (previous.has(tabKey) === hasUnsavedChanges) return previous;
      const next = new Set(previous);
      if (hasUnsavedChanges) next.add(tabKey);
      else next.delete(tabKey);
      dirtyTabKeysRef.current = next;
      return next;
    });
  }, []);

  // Opens the file in its own tab, or switches to the tab it already has. Returns whether it was opened, i.e.
  // false when the user kept an unsaved buffer, so callers can skip follow-ups such as switching tabs.
  const handleFileOpen = useCallback(
    (
      filePath: string,
      diffInfo: CodeEditorDiffInfo | null = null,
      line: number | null = null,
      character: number | null = null,
    ): boolean => {
      const projectId = selectedProject?.projectId;
      const key = getTabKey(filePath, projectId, selectedProject?.path);
      const gotoTarget = line ? { line, ...(character !== null ? { character } : {}) } : null;
      const existingTab = tabsRef.current.find((tab) => tab.key === key);

      // A diff payload, or leaving one, reloads the tab's buffer, so that asks like closing does.
      const reloadsBuffer = existingTab !== undefined && Boolean(existingTab.file.diffInfo || diffInfo);
      if (
        reloadsBuffer
        && dirtyTabKeysRef.current.has(key)
        // No inline fallback here on purpose: CodeEditor's `requestClose` owns
        // the one for this key, and two copies would eventually disagree.
        && !window.confirm(t('unsavedChanges.confirmClose'))
      ) {
        return false;
      }

      const normalizedPath = filePath.replace(/\\/g, '/');
      const file: CodeEditorFile = {
        name: normalizedPath.split('/').pop() || filePath,
        path: filePath,
        // DB projectId is forwarded to the editor so it can read/save files
        // via `/api/file-tree/projects/:projectId/file` endpoints.
        projectId,
        diffInfo,
      };

      const previousTabs = tabsRef.current;
      let nextTabs: CodeEditorTab[];
      if (existingTab) {
        nextTabs = previousTabs.map((tab) => (tab.key !== key ? tab : {
          key,
          file: reloadsBuffer ? file : tab.file,
          gotoTarget: gotoTarget ?? (reloadsBuffer ? null : tab.gotoTarget),
        }));
      } else {
        // A new tab opens right of the active one, as in VS Code.
        const activeIndex = previousTabs.findIndex((tab) => tab.key === activeTabKeyRef.current);
        nextTabs = [...previousTabs];
        nextTabs.splice(activeIndex + 1, 0, { key, file, gotoTarget });
      }
      tabsRef.current = nextTabs;
      activeTabKeyRef.current = key;
      setTabs(nextTabs);
      setActiveTabKey(key);
      return true;
    },
    [selectedProject?.projectId, selectedProject?.path, t],
  );

  const handleActivateTab = useCallback((tabKey: string) => {
    activeTabKeyRef.current = tabKey;
    setActiveTabKey(tabKey);
  }, []);

  // Closes without asking; the callers (the editor's own close, the tab strip) confirm a dirty buffer first.
  const handleCloseTab = useCallback((tabKey: string) => {
    const previousTabs = tabsRef.current;
    const closedIndex = previousTabs.findIndex((tab) => tab.key === tabKey);
    if (closedIndex < 0) return;
    const nextTabs = previousTabs.filter((tab) => tab.key !== tabKey);
    tabsRef.current = nextTabs;
    setTabs(nextTabs);

    if (activeTabKeyRef.current === tabKey) {
      // The neighbour to the right takes over, or the left one at the end, as in VS Code.
      const nextActiveKey = nextTabs[Math.min(closedIndex, nextTabs.length - 1)]?.key ?? null;
      activeTabKeyRef.current = nextActiveKey;
      setActiveTabKey(nextActiveKey);
    }
    if (nextTabs.length === 0) setEditorExpanded(false);
  }, []);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isMobile) {
        return;
      }

      setIsResizing(true);
      event.preventDefault();
    },
    [isMobile],
  );

  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    // `editorWidth` is read by WorkspaceMain, so every commit re-renders the
    // whole workspace including the chat transcript. A high-polling-rate mouse
    // fires several mousemove events per frame, so the width is coalesced to one
    // commit per frame — the same visual result for a fraction of the renders.
    let pendingWidth: number | null = null;
    let frameHandle: number | null = null;

    const commitPendingWidth = () => {
      frameHandle = null;
      if (pendingWidth !== null) {
        setEditorWidth(pendingWidth);
        pendingWidth = null;
      }
    };

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      // Get the main container (parent of EditorSidebar's parent) that contains both left content and editor
      const editorContainer = resizeHandleRef.current?.parentElement;
      const mainContainer = editorContainer?.parentElement;
      if (!mainContainer) {
        return;
      }

      const containerRect = mainContainer.getBoundingClientRect();
      // Calculate new editor width: distance from mouse to right edge of main container
      const newWidth = containerRect.right - event.clientX;

      const minWidth = 300;
      const maxWidth = containerRect.width * 0.8;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        pendingWidth = newWidth;
        if (frameHandle === null) {
          frameHandle = requestAnimationFrame(commitPendingWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      // Land on the last position the pointer reached rather than the last
      // frame that happened to commit.
      commitPendingWidth();
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  return {
    tabs,
    activeTabKey,
    dirtyTabKeys,
    editingFile,
    editorWidth,
    editorExpanded,
    resizeHandleRef,
    handleFileOpen,
    handleActivateTab,
    handleCloseTab,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  };
};
