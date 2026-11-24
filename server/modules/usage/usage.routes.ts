import express from 'express';

import type { createClaudeBillingService } from './claude-billing.service.js';
import type { createClaudeCreditService } from './claude-credit.service.js';
import type { createUsageLoginService } from './usage-login.service.js';
import type { createUsageService } from './usage.service.js';
import type { createWorkdayPingService } from './workday-ping.service.js';

/** Creates the plan-usage routes the sidebar polls for its limit bars, the sign-in that renews their token, and the settings routes for the fallback API key and the API credit cycle. */
export function createUsageRouter(
  usageService: ReturnType<typeof createUsageService>,
  usageLogin: ReturnType<typeof createUsageLoginService>,
  billing: ReturnType<typeof createClaudeBillingService>,
  credit: ReturnType<typeof createClaudeCreditService>,
  workdayPing: ReturnType<typeof createWorkdayPingService>,
): express.Router {
  const router = express.Router();

  router.get('/', async (_request, response) => {
    response.json({ ...usageService.getUsage(), billing: billing.getStatus(), credit: await credit.getStatus() });
  });

  router.post('/refresh', async (_request, response) => {
    try {
      response.json({ ...(await usageService.refreshUsage()), billing: billing.getStatus(), credit: await credit.getStatus() });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/login', (_request, response) => {
    response.json(usageLogin.start());
  });

  // Saves the token from the pasted code, then fetches a reading with it so the bars update in the same round trip.
  router.post('/login/complete', async (request, response) => {
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    try {
      await usageLogin.complete(code);
      response.json({ ...(await usageService.refreshUsage()), billing: billing.getStatus(), credit: await credit.getStatus() });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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

  router.put('/claude-api-fallback', (request, response) => {
    if (typeof request.body?.armed !== 'boolean') {
      response.status(400).json({ error: 'armed (boolean) is required' });
      return;
    }
    billing.setArmed(request.body.armed);
    response.json(billing.getStatus());
  });

  router.get('/claude-credit', async (_request, response) => {
    response.json(await credit.getStatus());
  });

  router.put('/claude-credit/key', async (request, response) => {
    const key = typeof request.body?.key === 'string' ? request.body.key.trim() : '';
    if (!key) {
      response.status(400).json({ error: 'key is required' });
      return;
    }
    response.json(await credit.setKey(key));
  });

  router.delete('/claude-credit/key', (_request, response) => {
    response.json(credit.clearKey());
  });

  router.put('/claude-credit/cycle', async (request, response) => {
    const renewalDay = Number(request.body?.renewalDay);
    const amount = request.body?.amount === null || request.body?.amount === '' ? null : Number(request.body?.amount);
    if (!Number.isInteger(renewalDay) || renewalDay < 1 || renewalDay > 31) {
      response.status(400).json({ error: 'renewalDay must be a whole number from 1 to 31' });
      return;
    }
    if (amount !== null && !(Number.isFinite(amount) && amount > 0)) {
      response.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    response.json(await credit.setCycle({ renewalDay, amount }));
  });

  router.get('/workday-ping', (_request, response) => {
    response.json(workdayPing.getStatus());
  });

  router.put('/workday-ping', (request, response) => {
    const enabled = request.body?.enabled;
    const time = request.body?.time;
    if (typeof enabled !== 'boolean' || typeof time !== 'string') {
      response.status(400).json({ error: 'enabled (boolean) and time (HH:MM) are required' });
      return;
    }
    try {
      response.json(workdayPing.setConfig({ enabled, time }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
