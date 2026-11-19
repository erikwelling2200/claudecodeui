import express from 'express';

import type { createServerRestartService } from './server-restart.service.js';
import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update and restart execution to the services. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  serverRestartService: ReturnType<typeof createServerRestartService>,
): express.Router {
  const router = express.Router();

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/restart', (_request, response) => {
    // The restart ends this process, so the answer has to be on the wire before it begins.
    response.once('finish', () => {
      serverRestartService.restart().catch((error: unknown) => {
        console.error('[System] Restart failed:', error instanceof Error ? error.message : String(error));
      });
    });
    response.status(202).json({ success: true, data: serverRestartService.describe() });
  });

  return router;
}
