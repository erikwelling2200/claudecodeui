import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { LockstepGroup } from '@/shared/types';
import { Button, Input } from '@/shared/ui';
import { getFolderName } from '@/shared/utils';

type LockstepGroupsEditorProps = {
  projectId: string;
  // Lets the worktree list re-read its units once groups change.
  onSaved: () => void;
};

function samePath(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/, '').toLowerCase() === right.replace(/[\\/]+$/, '').toLowerCase();
}

/** Edits which of the project's saved folders are lockstepped together, and under what name. */
export default function LockstepGroupsEditor({ projectId, onSaved }: LockstepGroupsEditorProps) {
  const { t } = useTranslation();
  // The project's saved folders, as the server knows them; only these can be grouped.
  const [folders, setFolders] = useState<string[]>([]);
  // Draft of the groups, saved as a whole with the save button.
  const [groups, setGroups] = useState<LockstepGroup[]>([]);
  // True from a save request until its answer, to lock the editor.
  const [isSaving, setIsSaving] = useState(false);
  // Why loading or saving failed (duplicate name, folder already grouped, ...).
  const [error, setError] = useState<string | null>(null);
  // Whether the draft differs from what was last loaded or saved, to enable the save button.
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await readApiJson<{ data: { folders: string[]; groups: LockstepGroup[] } }>(await api.worktreeClaims.groups(projectId));
        if (cancelled) return;
        setFolders(payload.data.folders);
        setGroups(payload.data.groups);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const updateGroups = useCallback((update: (previous: LockstepGroup[]) => LockstepGroup[]) => {
    setGroups(update);
    setIsDirty(true);
  }, []);

  const toggleFolder = (groupIndex: number, folder: string) => updateGroups((previous) => previous.map((group, index) => {
    if (index !== groupIndex) return group;
    const has = group.repos.some((repo) => samePath(repo, folder));
    return { ...group, repos: has ? group.repos.filter((repo) => !samePath(repo, folder)) : [...group.repos, folder] };
  }));

  const save = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const payload = await readApiJson<{ data: { groups: LockstepGroup[] } }>(await api.worktreeClaims.saveGroups(projectId, groups));
      setGroups(payload.data.groups);
      setIsDirty(false);
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setIsSaving(false);
    }
  }, [groups, onSaved, projectId]);

  // A folder in one group is not offered to the others: the hook resolves a repo to one group.
  const groupOf = (folder: string) => groups.findIndex((group) => group.repos.some((repo) => samePath(repo, folder)));

  return (
    <div className="space-y-3">
      <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('worktreeClaims.groups.title')}</span>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {groups.map((group, groupIndex) => (
        <div key={groupIndex} className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Input
              value={group.name}
              onChange={(event) => updateGroups((previous) => previous.map((other, index) => (index === groupIndex ? { ...other, name: event.target.value } : other)))}
              placeholder={t('worktreeClaims.groups.namePlaceholder')}
              className="flex-1"
              disabled={isSaving}
            />
            <button
              type="button"
              onClick={() => updateGroups((previous) => previous.filter((_, index) => index !== groupIndex))}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700"
              aria-label={t('worktreeClaims.groups.remove')}
              disabled={isSaving}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {folders.map((folder) => {
              const owner = groupOf(folder);
              if (owner !== -1 && owner !== groupIndex) return null;
              return (
                <label key={folder} className="flex cursor-pointer items-center gap-1.5 rounded border border-gray-200 px-2 py-1 text-xs dark:border-gray-700" title={folder}>
                  <input type="checkbox" checked={owner === groupIndex} onChange={() => toggleFolder(groupIndex, folder)} disabled={isSaving} />
                  {getFolderName(folder)}
                </label>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => updateGroups((previous) => [...previous, { name: '', repos: [] }])} disabled={isSaving}>
          <Plus className="h-4 w-4" />
          {t('worktreeClaims.groups.add')}
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={isSaving || !isDirty}>
          {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('worktreeClaims.groups.save')}
        </Button>
      </div>
    </div>
  );
}
