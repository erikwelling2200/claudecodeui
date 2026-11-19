import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';
import { pickFoldersNatively } from '@/modules/project-creation-wizard/utils/workspaceApi';

type ProjectFolderListFieldProps = {
  folders: string[];
  disabled?: boolean;
  onChange: (folders: string[]) => void;
};

/** Rendered by StepConfiguration and EditProjectModal to edit the extra folders of a project, one path row per folder. */
export default function ProjectFolderListField({
  folders,
  disabled = false,
  onChange,
}: ProjectFolderListFieldProps) {
  const { t } = useTranslation();
  const [openingDialog, setOpeningDialog] = useState(false);

  const updateFolder = (index: number, value: string) => {
    onChange(folders.map((folder, folderIndex) => (folderIndex === index ? value : folder)));
  };

  const insertFoldersAfter = (index: number, folderPaths: string[]) => {
    onChange([...folders.slice(0, index + 1), ...folderPaths, ...folders.slice(index + 1)]);
  };

  const removeFolder = (index: number) => {
    onChange(folders.filter((_, folderIndex) => folderIndex !== index));
  };

  /**
   * Adds as many rows as the user picks folders in one go. With no dialog on
   * the server's machine this falls back to the empty row it always added,
   * which the row's own browse button then fills in.
   */
  const addFolders = async () => {
    setOpeningDialog(true);

    try {
      const selection = await pickFoldersNatively({
        multiple: true,
        title: t('folderBrowser.titleMultiple'),
      });

      if (selection.available) {
        if (selection.paths.length > 0) {
          onChange([...folders, ...selection.paths]);
        }
        return;
      }
    } catch (error) {
      console.error('Native folder dialog failed, adding an empty folder row instead:', error);
    } finally {
      setOpeningDialog(false);
    }

    onChange([...folders, '']);
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.folders.label')}
      </label>

      <div className="space-y-2">
        {folders.map((folder, index) => (
          // Rows have no identity besides their position.
          <div key={index} className="flex items-start gap-2">
            <div className="flex-1">
              <WorkspacePathField
                value={folder}
                disabled={disabled}
                onChange={(value) => updateFolder(index, value)}
                onExtraFoldersPicked={(folderPaths) => insertFoldersAfter(index, folderPaths)}
                ariaLabel={t('projectWizard.folders.label')}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              className="px-3"
              onClick={() => removeFolder(index)}
              disabled={disabled}
              title={t('projectWizard.folders.remove')}
              aria-label={t('projectWizard.folders.remove')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        onClick={addFolders}
        disabled={disabled || openingDialog}
      >
        {openingDialog ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {t('projectWizard.folders.add')}
      </Button>
    </div>
  );
}
