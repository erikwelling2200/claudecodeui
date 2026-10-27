import { useCallback, useState } from 'react';

import GroupWorktreesList from '@/modules/worktree-claims/GroupWorktreesList';
import LockstepGroupsEditor from '@/modules/worktree-claims/LockstepGroupsEditor';

/** Rendered by the project-creation-wizard module's edit dialog: lockstep groups and their worktrees. */
export function ProjectWorktreesSection({ projectId }: { projectId: string }) {
  // Bumped after the groups are saved, so the worktree list regroups its units.
  const [groupsVersion, setGroupsVersion] = useState(0);
  const handleGroupsSaved = useCallback(() => setGroupsVersion((version) => version + 1), []);

  return (
    <div className="space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      <LockstepGroupsEditor projectId={projectId} onSaved={handleGroupsSaved} />
      <GroupWorktreesList projectId={projectId} refreshToken={groupsVersion} />
    </div>
  );
}
