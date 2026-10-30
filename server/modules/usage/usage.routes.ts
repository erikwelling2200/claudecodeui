import express from 'express';

import type { createClaudeBillingService } from './claude-billing.service.js';
import type { createUsageService } from './usage.service.js';

/** Creates the plan-usage routes the sidebar polls for its limit bars, and the fallback API key's settings routes. */
export function createUsageRouter(
  usageService: ReturnType<typeof createUsageService>,
  billing: ReturnType<typeof createClaudeBillingService>,
): express.Router {
  const router = express.Router();

  router.get('/', (_request, response) => {
    response.json({ ...usageService.getUsage(), billing: billing.getStatus() });
  });

  router.post('/refresh', async (_request, response) => {
    try {
      response.json({ ...(await usageService.refreshUsage()), billing: billing.getStatus() });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/claude-api-key', (_request, response) => {
    response.json(billing.getStatus());
  });

  router.put('/claude-api-key', (request, response) => {
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    if (!key) {
      response.status(400).json({ error: 'key is required' });
      return;
    }
    billing.setKey(key);
    response.json(billing.getStatus());
  });

  router.delete('/claude-api-key', (_request, response) => {
    billing.clearKey();
    response.json(billing.getStatus());
  });

  return router;
}
