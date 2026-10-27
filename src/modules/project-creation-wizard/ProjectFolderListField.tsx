import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import WorkspacePathField from '@/modules/project-creation-wizard/WorkspacePathField';

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

  const updateFolder = (index: number, value: string) => {
    onChange(folders.map((folder, folderIndex) => (folderIndex === index ? value : folder)));
  };

  const removeFolder = (index: number) => {
    onChange(folders.filter((_, folderIndex) => folderIndex !== index));
  };

  return (
    <div>
      <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('projectWizard.folders.label')}
      </label>

      <div className="space-y-2">
        {folders.map((folder, index) => (
          // Rows have no identity besides their position; a removal re-keys the
          // later rows, which only resets their autocomplete dropdowns.
          <div key={index} className="flex items-start gap-2">
            <div className="flex-1">
              <WorkspacePathField
                value={folder}
                disabled={disabled}
                onChange={(value) => updateFolder(index, value)}
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
        onClick={() => onChange([...folders, ''])}
        disabled={disabled}
      >
        <Plus className="h-4 w-4" />
        {t('projectWizard.folders.add')}
      </Button>
    </div>
  );
}
