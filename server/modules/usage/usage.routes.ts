import express from 'express';

import type { createUsageService } from './usage.service.js';

/** Creates the plan-usage routes the sidebar polls for its limit bars. */
export function createUsageRouter(usageService: ReturnType<typeof createUsageService>): express.Router {
  const router = express.Router();

  router.get('/', (_request, response) => {
    response.json(usageService.getUsage());
  });

  router.post('/refresh', async (_request, response) => {
    try {
      response.json(await usageService.refreshUsage());
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
