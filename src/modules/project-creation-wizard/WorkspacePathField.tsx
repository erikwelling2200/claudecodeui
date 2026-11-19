import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Loader2 } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import FolderBrowserModal from '@/modules/project-creation-wizard/modals/FolderBrowserModal';
import { pickFoldersNatively } from '@/modules/project-creation-wizard/utils/workspaceApi';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  // Only the wizard's primary folder field moves on to the review step.
  onAdvanceToConfirm?: () => void;
  // Given, the dialog lets the user pick several folders at once: the first
  // one lands in this field and the rest go here.
  onExtraFoldersPicked?: (folderPaths: string[]) => void;
  ariaLabel?: string;
};

/** Rendered by StepConfiguration and ProjectFolderListField to enter a folder path by typing or with a browse button. */
export default function WorkspacePathField({
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
  onExtraFoldersPicked,
  ariaLabel,
}: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [openingDialog, setOpeningDialog] = useState(false);
  const allowMultiple = Boolean(onExtraFoldersPicked);

  const handleFolderSelected = useCallback(
    (selectedPath: string, advanceToConfirm: boolean) => {
      onChange(selectedPath);
      setShowFolderBrowser(false);
      if (advanceToConfirm) {
        onAdvanceToConfirm?.();
      }
    },
    [onAdvanceToConfirm, onChange],
  );

  /**
   * The operating system's own dialog is the one the user knows, so it is
   * what the browse button opens. A server without a desktop session has no
   * dialog to open, and then the in-app browser takes over.
   */
  const handleBrowse = useCallback(async () => {
    setOpeningDialog(true);

    try {
      const selection = await pickFoldersNatively({
        multiple: allowMultiple,
        initialPath: value.trim() || undefined,
        title: allowMultiple ? t('folderBrowser.titleMultiple') : t('folderBrowser.title'),
      });

      if (!selection.available) {
        setShowFolderBrowser(true);
        return;
      }

      const [firstPath, ...extraPaths] = selection.paths;
      if (!firstPath) {
        return;
      }

      onChange(firstPath);
      if (extraPaths.length > 0) {
        onExtraFoldersPicked?.(extraPaths);
      }
    } catch (error) {
      console.error('Native folder dialog failed, falling back to the in-app browser:', error);
      setShowFolderBrowser(true);
    } finally {
      setOpeningDialog(false);
    }
  }, [allowMultiple, onChange, onExtraFoldersPicked, t, value]);

  return (
    <>
      <div className="flex gap-2">
        <Input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/path/to/project/workspace"
          className="w-full flex-1"
          disabled={disabled}
          aria-label={ariaLabel}
        />

        <Button
          type="button"
          variant="outline"
          onClick={handleBrowse}
          className="px-3"
          title={t('common:misc.browseFolders')}
          disabled={disabled || openingDialog}
        >
          {openingDialog ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
        </Button>
      </div>

      <FolderBrowserModal
        isOpen={showFolderBrowser}
        autoAdvanceOnSelect={false}
        onClose={() => setShowFolderBrowser(false)}
        onFolderSelected={handleFolderSelected}
      />
    </>
  );
}
