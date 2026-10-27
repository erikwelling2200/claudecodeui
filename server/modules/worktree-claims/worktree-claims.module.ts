import { randomUUID } from 'node:crypto';

import { projectsDb } from '@/modules/database/index.js';
import type { WorktreeClaimsServices } from '@/shared/types.js';
import { AppError, isSameFolderPath } from '@/shared/utils.js';
import {
  readFindWorktreeJob,
  runFindWorktree,
  startFindWorktreeJob,
} from '@/modules/worktree-claims/services/find-worktree-script.service.js';
import {
  readProjectLockstepGroups,
  saveProjectLockstepGroups,
} from '@/modules/worktree-claims/services/lockstep-groups.service.js';
import { createWorktreeClaimsRouter } from '@/modules/worktree-claims/worktree-claims.routes.js';

function projectFolders(projectId: string): string[] {
  const folders = projectsDb.getProjectFolderPathsById(projectId);
  if (!folders) {
    throw new AppError(`Unable to resolve project "${projectId}"`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  return folders;
}

/** `group:<name>` / `repo:<path>`, as lock files and claims key a unit; it survives renaming the group. */
function readUnitKey(unitKey: string): string {
  if (!/^(group|repo):.+$/.test(unitKey)) {
    throw new AppError(`"${unitKey}" is not a worktree unit key`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return unitKey;
}

/** Production composition of the worktree-claims services. */
const worktreeClaimsServices: WorktreeClaimsServices = {
  getGroups: async (projectId) => readProjectLockstepGroups(projectFolders(projectId)),
  saveGroups: async (projectId, groups) => saveProjectLockstepGroups(projectFolders(projectId), groups),
  listWorktrees: async (projectId) => runFindWorktree(['list', ...projectFolders(projectId).flatMap((folder) => ['--repo', folder])]),
  async startCreate({ projectId, unit, suffix, from }) {
    const folders = projectFolders(projectId);
    const { groups } = await readProjectLockstepGroups(folders);
    // Only a unit of this project: one of its groups, or one of its folders.
    if (!groups.some((group) => group.name === unit) && !folders.some((folder) => isSameFolderPath(folder, unit))) {
      throw new AppError(`"${unit}" is neither a lockstep group nor a folder of this project`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    const jobId = randomUUID();
    startFindWorktreeJob(jobId, ['create', '--unit', unit, '--suffix', suffix, '--from', from]);
    return { jobId };
  },
  readJob: (jobId) => {
    if (!/^[\w-]+$/.test(jobId)) {
      throw new AppError('Invalid job id', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    return readFindWorktreeJob(jobId);
  },
  listClaims: (sessionId) => runFindWorktree(['claims', '--session', sessionId]),
  release: (unitKey, suffix) => runFindWorktree(['release', '--force', '--key', readUnitKey(unitKey), '--suffix', suffix]),
};

/** Worktree-claims router, mounted by the server entrypoint at `/api/worktree-claims`. */
export const worktreeClaimsRoutes = createWorktreeClaimsRouter(worktreeClaimsServices);
