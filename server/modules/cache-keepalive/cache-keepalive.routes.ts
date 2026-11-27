import express from 'express';
import type { Request, Response } from 'express';

import { cacheKeepaliveService } from '@/modules/cache-keepalive/services/cache-keepalive.service.js';
import { sessionsDb } from '@/modules/database/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readSessionId(request: Request): string {
  const sessionId = String(request.params.sessionId ?? '');
  if (!sessionsDb.getSessionById(sessionId)) {
    throw new AppError(`Session "${sessionId}" does not exist.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
  return sessionId;
}

const router = express.Router();

router.get(
  '/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(cacheKeepaliveService.getState(readSessionId(req))));
  }),
);

router.put(
  '/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const enabled = (req.body as Record<string, unknown> | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      throw new AppError('enabled must be true or false.', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    res.json(createApiSuccessResponse(cacheKeepaliveService.setEnabled(readSessionId(req), enabled)));
  }),
);

export default router;
