import { useState } from 'react';
import type { ReactNode } from 'react';

import type { CodeEditorFile } from '@/shared/types';
import CodeEditorHeader from '@/modules/code-editor/CodeEditorHeader';
import { HeaderActionsSlotContext } from '@/modules/code-editor/utils/headerActionsSlot';

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

/** Rendered by CodeEditor inside the code-editor module around every file type: the docked or modal container, the tabs and the shared header. */
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

  const header = (
    <CodeEditorHeader
      file={file}
      hasUnsavedChanges={hasUnsavedChanges}
      actionsSlotRef={setActionsSlot}
      isFullscreen={isSidebar ? isExpanded : isFullscreen}
      onToggleFullscreen={isSidebar ? onToggleExpand : onToggleFullscreen}
      onOpenInModal={isSidebar ? onPopOut : null}
    />
  );

  const content = (
    <HeaderActionsSlotContext.Provider value={actionsSlot}>
      {tabStrip}
      {header}
      {children}
    </HeaderActionsSlotContext.Provider>
  );

  if (isSidebar) {
    return <div className="flex h-full w-full flex-col bg-background">{content}</div>;
  }

  const outerClassName = `fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/50 ${isFullscreen ? 'md:p-0' : 'md:p-4'}`;
  const innerClassName = `flex h-full w-full flex-col bg-background shadow-2xl md:rounded-lg ${
    isFullscreen ? 'md:rounded-none' : 'md:h-[80vh] md:max-h-[80vh] md:max-w-6xl'
  }`;

  return (
    <div className={outerClassName}>
      <div className={innerClassName}>{content}</div>
    </div>
  );
}
