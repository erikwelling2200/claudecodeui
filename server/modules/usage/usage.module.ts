import { execFile } from 'node:child_process';
import os from 'node:os';

import { createUsageRouter } from './usage.routes.js';
import { createUsageService } from './usage.service.js';

const usageService = createUsageService({
  homeDirectory: os.homedir(),
  runUsageScript: (scriptPath) => new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, '--force'], { cwd: os.homedir(), timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  }),
});

/** Used by the server entrypoint to mount the authenticated plan-usage endpoints. */
export const usageRoutes = createUsageRouter(usageService);
