import { randomUUID } from 'node:crypto';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
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
import {
  getSessionWorktrees,
  recordSessionWorktreeClaims,
} from '@/modules/worktree-claims/services/session-worktrees.service.js';
import { readUnitKey } from '@/modules/worktree-claims/services/unit-keys.js';
import { createWorktreeClaimsRouter } from '@/modules/worktree-claims/worktree-claims.routes.js';

function projectFolders(projectId: string): string[] {
  const folders = projectsDb.getProjectFolderPathsById(projectId);
  if (!folders) {
    throw new AppError(`Unable to resolve project "${projectId}"`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  return folders;
}

// Locks are keyed by the provider's session id, which a chat started in the app only gets once its CLI reports it.
function lockSessionId(sessionId: string): string {
  return sessionsDb.getSessionById(sessionId)?.provider_session_id ?? sessionId;
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
  // The sidebar polls this while a chat is open, which catches a claim the hook could not report.
  async listClaims(sessionId) {
    const payload = await runFindWorktree(['claims', '--session', lockSessionId(sessionId)]) as { claims?: unknown };
    recordSessionWorktreeClaims(sessionId, payload?.claims);
    return payload;
  },
  release: (unitKey, suffix) => runFindWorktree(['release', '--force', '--key', readUnitKey(unitKey), '--suffix', suffix]),
  getSessionWorktrees: async (sessionId) => getSessionWorktrees(sessionId),
};

/**
 * The worktree locks a chat holds itself, for the `cloudcli-chat` MCP tools. Releasing never forces,
 * so a chat cannot drop another chat's lock.
 */
export const chatWorktreeLocks = {
  list: (sessionId: string) => runFindWorktree(['claims', '--session', lockSessionId(sessionId)]),
  release: (sessionId: string, target: { unitKey: string; suffix: string } | 'all') => runFindWorktree([
    'release', '--session', lockSessionId(sessionId),
    ...(target === 'all' ? [] : ['--key', readUnitKey(target.unitKey), '--suffix', target.suffix]),
  ]),
};

/** Worktree-claims router, mounted by the server entrypoint at `/api/worktree-claims`. */
export const worktreeClaimsRoutes = createWorktreeClaimsRouter(worktreeClaimsServices);
