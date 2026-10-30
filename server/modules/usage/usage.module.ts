import { execFile } from 'node:child_process';
import os from 'node:os';

import { appConfigDb, claudeApiSpendDb } from '@/modules/database/index.js';

import { createClaudeBillingService } from './claude-billing.service.js';
import { createUsageRouter } from './usage.routes.js';
import { createUsageService } from './usage.service.js';

const usageService = createUsageService({
  homeDirectory: os.homedir(),
  runUsageScript: (scriptPath) => new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, '--force'], { cwd: os.homedir(), timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  }),
});

/** Used by the Claude runtime to pick each run's credential and to record what API-key turns cost. */
export const claudeBilling = createClaudeBillingService({
  homeDirectory: os.homedir(),
  hostEnv: process.env,
  config: appConfigDb,
  spend: claudeApiSpendDb,
  readUsageLimits: () => usageService.getUsage().limits,
});

/** Used by the server entrypoint to mount the authenticated plan-usage endpoints. */
export const usageRoutes = createUsageRouter(usageService, claudeBilling);
