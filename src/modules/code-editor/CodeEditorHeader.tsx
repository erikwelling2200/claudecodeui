import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, ExternalLink, Maximize2, Minimize2, Search } from 'lucide-react';

import { copyTextToClipboard } from '@/shared/utils';
import type { CodeEditorFile } from '@/shared/types';
import { headerButtonActiveClassName, headerButtonClassName } from '@/modules/code-editor/utils/headerActionsSlot';

type CodeEditorHeaderProps = {
  file: CodeEditorFile;
  hasUnsavedChanges: boolean;
  // Where CodeEditorHeaderActions portals the open file type's own buttons.
  actionsSlotRef: Ref<HTMLDivElement>;
  isFindOpen: boolean;
  onToggleFind: () => void;
  // Whether the fullscreen toggle is on: the docked panel's expansion, or the modal's fullscreen.
  isFullscreen: boolean;
  onToggleFullscreen: (() => void) | null;
  // Only the docked editor can move into the modal.
  onOpenInModal: (() => void) | null;
};

/** Rendered by CodeEditorFrame inside the code-editor module as the one header every file type shares: name, path and layout toggles. */
export default function CodeEditorHeader({
  file,
  hasUnsavedChanges,
  actionsSlotRef,
  isFindOpen,
  onToggleFind,
  isFullscreen,
  onToggleFullscreen,
  onOpenInModal,
}: CodeEditorHeaderProps) {
  const { t } = useTranslation('codeEditor');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyResetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathCopied = copiedPath === file.path;
  const copyLabel = pathCopied ? t('actions.pathCopied', 'File path copied') : t('actions.copyPath', 'Copy file path');
  const unsavedLabel = t('unsavedChanges.indicator', 'Unsaved changes');
  const fullscreenLabel = isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen');

  useEffect(() => () => {
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
  }, []);

  const handleCopyPath = async () => {
    if (!(await copyTextToClipboard(file.path))) return;
    setCopiedPath(file.path);
    if (copyResetTimeoutRef.current) clearTimeout(copyResetTimeoutRef.current);
    copyResetTimeoutRef.current = setTimeout(() => setCopiedPath(null), 2000);
  };

  return (
    <div className="flex min-w-0 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-base font-semibold text-gray-900 dark:text-white">{file.name}</h3>
          {hasUnsavedChanges && (
            <span role="img" aria-label={unsavedLabel} title={unsavedLabel} className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
          )}
          {file.diffInfo && (
            <span className="shrink-0 whitespace-nowrap rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-600 dark:bg-blue-900 dark:text-blue-300">
              {t('header.showingChanges')}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <p className="truncate text-xs text-gray-500 dark:text-gray-400" title={file.path}>{file.path}</p>
          <button
            type="button"
            onClick={handleCopyPath}
            className={`flex shrink-0 items-center justify-center rounded p-0.5 transition-colors ${
              pathCopied
                ? 'text-green-600 dark:text-green-400'
                : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200'
            }`}
            title={copyLabel}
            aria-label={copyLabel}
          >
            {pathCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <div ref={actionsSlotRef} className="flex items-center gap-0.5 empty:hidden" />
        <button
          type="button"
          onClick={onToggleFind}
          className={isFindOpen ? headerButtonActiveClassName : headerButtonClassName}
          title={t('find.open', 'Find (Ctrl+F)')}
          aria-label={t('find.open', 'Find (Ctrl+F)')}
          aria-pressed={isFindOpen}
        >
          <Search className="h-4 w-4" />
        </button>
        {onOpenInModal && (
          <button type="button" onClick={onOpenInModal} className={headerButtonClassName} title={t('toolbar.popOut', 'Open in modal')} aria-label={t('toolbar.popOut', 'Open in modal')}>
            <ExternalLink className="h-4 w-4" />
          </button>
        )}
        {onToggleFullscreen && (
          <button type="button" onClick={onToggleFullscreen} className={headerButtonClassName} title={fullscreenLabel} aria-label={fullscreenLabel}>
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
