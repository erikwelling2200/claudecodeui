import { useCallback, useState } from 'react';
import { FolderCog, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '@/shared/ui';
import { getFolderName } from '@/shared/utils';
import type { Project } from '@/shared/types';
import { ProjectWorktreesSection } from '@/modules/worktree-claims';
import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import ProjectFolderListField from '@/modules/project-creation-wizard/ProjectFolderListField';
import { getSubmittedFolders } from '@/modules/project-creation-wizard/utils/pathUtils';
import { updateProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';

type EditProjectModalProps = {
  project: Project;
  onClose: () => void;
  // Re-syncs the project list after a successful save.
  onProjectUpdated: () => void;
};

/** Rendered by the sidebar module's modal layer to edit a project's name and extra folders; the primary folder is shown read-only. */
export default function EditProjectModal({ project, onClose, onProjectUpdated }: EditProjectModalProps) {
  const { t } = useTranslation();
  // Draft of the project name, seeded from the project and saved on submit.
  const [projectName, setProjectName] = useState(project.displayName ?? '');
  // Draft of the extra folder rows; blank rows are dropped when saving.
  const [additionalFolders, setAdditionalFolders] = useState<string[]>(
    () => project.additionalFolders ?? [],
  );
  // True while the PATCH is in flight, to lock the form and the close button.
  const [isSaving, setIsSaving] = useState(false);
  // The server's reason the last save failed (missing, nested or duplicate folder, ...).
  const [error, setError] = useState<string | null>(null);

  const primaryFolder = project.fullPath || project.path || '';

  // A <div>, not a <form>: the folder rows contain plain buttons (suggestions,
  // folder browser) that would otherwise submit it.
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);

    const trimmedName = projectName.trim();
    try {
      await updateProjectRequest(project.projectId, {
        // An empty name keeps the current one instead of clearing it.
        ...(trimmedName && trimmedName !== project.displayName ? { displayName: trimmedName } : {}),
        additionalFolders: getSubmittedFolders(additionalFolders),
      });
      onProjectUpdated();
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('projectWizard.edit.failed'));
    } finally {
      setIsSaving(false);
    }
  }, [additionalFolders, onClose, onProjectUpdated, project.displayName, project.projectId, projectName, t]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div
        className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-project-title"
      >
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderCog className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 id="edit-project-title" className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.edit.title')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isSaving}
            aria-label={t('projectWizard.buttons.cancel')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {error && <ErrorBanner message={error} />}

          <div>
            <label
              htmlFor="edit-project-name"
              className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('projectWizard.name.label')}
            </label>
            <Input
              id="edit-project-name"
              type="text"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder={getFolderName(primaryFolder)}
              className="w-full"
              disabled={isSaving}
            />
          </div>

          <div>
            <span className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('projectWizard.edit.primaryFolder')}
            </span>
            <p className="break-all rounded-md border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300">
              {primaryFolder}
            </p>
          </div>

          <ProjectFolderListField
            folders={additionalFolders}
            disabled={isSaving}
            onChange={setAdditionalFolders}
          />

          <ProjectWorktreesSection projectId={project.projectId} />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 p-6 dark:border-gray-700">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            {t('projectWizard.buttons.cancel')}
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('projectWizard.edit.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
