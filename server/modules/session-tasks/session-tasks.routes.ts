import express from 'express';

import type { SessionTasksServices } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId) {
    throw new AppError('session is required', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return sessionId;
}

/** Builds the session-tasks HTTP router: the task list a chat is keeping. */
export function createSessionTasksRouter(services: SessionTasksServices): express.Router {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const tasks = await services.listTasks(readSessionId(req.query.session));
    res.json(createApiSuccessResponse({ tasks }));
  }));

  return router;
}
