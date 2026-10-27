import express from 'express';

import type { LockstepGroup, WorktreeClaimsServices } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readRequiredString(value: unknown, name: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new AppError(`${name} is required`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return parsed;
}

/** A worktree suffix, the `<x>` of `<repo>-<x>`; '' names the main checkout. */
function readSuffix(value: unknown, name: string): string {
  const suffix = typeof value === 'string' ? value.trim() : null;
  if (suffix === null || (suffix !== '' && !/^[\w.-]+$/.test(suffix))) {
    throw new AppError(`${name} must be a worktree suffix of letters, digits, ".", "_" or "-"`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return suffix;
}

function readGroups(value: unknown): LockstepGroup[] {
  if (!Array.isArray(value)) {
    throw new AppError('groups must be an array', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value.map((group: unknown) => {
    const record = (typeof group === 'object' && group !== null ? group : {}) as Record<string, unknown>;
    if (typeof record.name !== 'string' || !Array.isArray(record.repos) || record.repos.some((repo) => typeof repo !== 'string')) {
      throw new AppError('Each group needs a name and a list of folder paths', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    return { name: record.name, repos: record.repos as string[] };
  });
}

/**
 * Builds the worktree-claims HTTP router: a project's lockstep groups, the
 * worktrees of each group, creating a worktree, and the worktrees a chat holds.
 */
export function createWorktreeClaimsRouter(services: WorktreeClaimsServices): express.Router {
  const router = express.Router();

  router.get('/groups', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await services.getGroups(readRequiredString(req.query.project, 'project'))));
  }));

  router.put('/groups', asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const result = await services.saveGroups(readRequiredString(body.project, 'project'), readGroups(body.groups));
    res.json(createApiSuccessResponse(result));
  }));

  router.get('/worktrees', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await services.listWorktrees(readRequiredString(req.query.project, 'project'))));
  }));

  router.post('/worktrees', asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const result = await services.startCreate({
      projectId: readRequiredString(body.project, 'project'),
      unit: readRequiredString(body.unit, 'unit'),
      suffix: readRequiredString(readSuffix(body.suffix, 'suffix'), 'suffix'),
      from: readSuffix(body.from ?? '', 'from'),
    });
    res.json(createApiSuccessResponse(result));
  }));

  router.get('/jobs/:jobId', asyncHandler(async (req, res) => {
    const job = await services.readJob(readRequiredString(req.params.jobId, 'jobId'));
    res.json(createApiSuccessResponse({ job }));
  }));

  router.get('/claims', asyncHandler(async (req, res) => {
    res.json(createApiSuccessResponse(await services.listClaims(readRequiredString(req.query.session, 'session'))));
  }));

  router.post('/release', asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const result = await services.release(readRequiredString(body.unit, 'unit'), readSuffix(body.suffix, 'suffix'));
    res.json(createApiSuccessResponse(result));
  }));

  return router;
}
