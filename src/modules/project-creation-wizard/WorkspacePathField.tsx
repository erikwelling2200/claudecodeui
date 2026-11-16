import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import FolderBrowserModal from '@/modules/project-creation-wizard/modals/FolderBrowserModal';

type WorkspacePathFieldProps = {
  value: string;
  disabled?: boolean;
  onChange: (path: string) => void;
  // Only the wizard's primary folder field moves on to the review step.
  onAdvanceToConfirm?: () => void;
  ariaLabel?: string;
};

/** Rendered by StepConfiguration and ProjectFolderListField to enter a folder path by typing or with a browse button. */
export default function WorkspacePathField({
  value,
  disabled = false,
  onChange,
  onAdvanceToConfirm,
  ariaLabel,
}: WorkspacePathFieldProps) {
  const { t } = useTranslation();
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

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
          onClick={() => setShowFolderBrowser(true)}
          className="px-3"
          title={t('common:misc.browseFolders')}
          disabled={disabled}
        >
          <FolderOpen className="h-4 w-4" />
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
