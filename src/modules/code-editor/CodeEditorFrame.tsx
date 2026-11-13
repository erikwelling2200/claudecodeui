import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { CodeEditorFile } from '@/shared/types';
import CodeEditorFindBar from '@/modules/code-editor/CodeEditorFindBar';
import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';
import { HeaderActionsSlotContext } from '@/modules/code-editor/utils/headerActionsSlot';
import { useFileFind } from '@/modules/code-editor/hooks/useFileFind';
import { FileSearchRegistryContext } from '@/modules/code-editor/hooks/useFileSearchProvider';
import { getFileAccess } from '@/modules/code-editor/utils/fileSearch';

type CodeEditorFrameProps = {
  file: CodeEditorFile;
  // The open-file tabs, drawn above the header.
  tabStrip: ReactNode;
  isSidebar: boolean;
  isExpanded: boolean;
  isFullscreen: boolean;
  onToggleExpand: (() => void) | null;
  onPopOut: (() => void) | null;
  onToggleFullscreen: () => void;
  hasUnsavedChanges?: boolean;
  // The file-type view; it adds header buttons through CodeEditorHeaderActions.
  children: ReactNode;
};

/** The selected text as a find seed: only a short single line, as anything longer is a selection, not a search term. */
const getSelectionSeed = (): string => {
  const selected = window.getSelection()?.toString() ?? '';
  return selected.length > 0 && selected.length <= 200 && !selected.includes('\n') ? selected : '';
};

/** Rendered by CodeEditor inside the code-editor module around every file type: the docked or modal container, the tabs, the shared header and the find bar. */
export default function CodeEditorFrame({
  file,
  tabStrip,
  isSidebar,
  isExpanded,
  isFullscreen,
  onToggleExpand,
  onPopOut,
  onToggleFullscreen,
  hasUnsavedChanges = false,
  children,
}: CodeEditorFrameProps) {
  // State rather than a ref, so views that render before the header mounts portal into it once it exists.
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [findFocusRequest, setFindFocusRequest] = useState(0);
  const access = getFileAccess(file.name);
  const find = useFileFind({ access, body });

  const openFind = (withReplace: boolean) => {
    find.open(withReplace, getSelectionSeed());
    setFindFocusRequest((request) => request + 1);
  };

  // Capture phase, so the shortcuts win over the text editor's own keymap.
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (modifier && !event.altKey && !event.shiftKey && (key === 'f' || key === 'h')) {
      event.preventDefault();
      event.stopPropagation();
      openFind(key === 'h');
    } else if (event.key === 'F3' && find.isOpen) {
      event.preventDefault();
      if (event.shiftKey) find.goToPrevious();
      else find.goToNext();
    }
  };

  const header = (
    <CodeEditorHeader
      file={file}
      hasUnsavedChanges={hasUnsavedChanges}
      actionsSlotRef={setActionsSlot}
      isFindOpen={find.isOpen}
      onToggleFind={() => (find.isOpen ? find.close() : openFind(false))}
      isFullscreen={isSidebar ? isExpanded : isFullscreen}
      onToggleFullscreen={isSidebar ? onToggleExpand : onToggleFullscreen}
      onOpenInModal={isSidebar ? onPopOut : null}
    />
  );

  const content = (
    <HeaderActionsSlotContext.Provider value={actionsSlot}>
      <FileSearchRegistryContext.Provider value={find.registry}>
        {tabStrip}
        {header}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {find.isOpen && <CodeEditorFindBar find={find} isReadOnly={access === 'read-only'} focusRequest={findFocusRequest} />}
          <div ref={setBody} className="flex min-h-0 flex-1 flex-col">
            {children}
          </div>
        </div>
      </FileSearchRegistryContext.Provider>
    </HeaderActionsSlotContext.Provider>
  );

  if (isSidebar) {
    return <div className="flex h-full w-full flex-col bg-background" onKeyDownCapture={handleKeyDownCapture}>{content}</div>;
  }

  const outerClassName = `fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/50 ${isFullscreen ? 'md:p-0' : 'md:p-4'}`;
  const innerClassName = `flex h-full w-full flex-col bg-background shadow-2xl md:rounded-lg ${
    isFullscreen ? 'md:rounded-none' : 'md:h-[80vh] md:max-h-[80vh] md:max-w-6xl'
  }`;

  return (
    <div className={outerClassName}>
      <div className={innerClassName} onKeyDownCapture={handleKeyDownCapture}>{content}</div>
    </div>
  );
}
