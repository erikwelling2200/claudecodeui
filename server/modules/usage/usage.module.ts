import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appConfigDb, claudeApiSpendDb, claudeApiUsageDb } from '@/modules/database/index.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';

import { createClaudeAccountsService } from './claude-accounts.service.js';
import { createClaudeBillingService } from './claude-billing.service.js';
import { createClaudeCreditService } from './claude-credit.service.js';
import { createClaudeListPrices } from './claude-list-prices.service.js';
import { createUsageLoginService } from './usage-login.service.js';
import { createUsageRouter } from './usage.routes.js';
import { createUsageService } from './usage.service.js';
import { createWorkdayPingService } from './workday-ping.service.js';

const usageLogin = createUsageLoginService({ homeDirectory: os.homedir(), fetch: globalThis.fetch });

const usageService = createUsageService({
  homeDirectory: os.homedir(),
  runUsageScript: (scriptPath) => new Promise((resolve, reject) => {
    execFile(process.execPath, [scriptPath, '--force'], { cwd: os.homedir(), timeout: 30_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  }),
  tokenUsable: usageLogin.tokenUsable,
});

const claudeCredit = createClaudeCreditService({
  config: appConfigDb,
  fetch: globalThis.fetch,
  listPrices: createClaudeListPrices({ fetch: globalThis.fetch }),
  recentUsage: (since) => claudeApiUsageDb.listSince(since),
});

/** Used by the server entrypoint to keep the extra subscriptions' tokens and usage fresh, and by the usage routes to manage them. */
export const claudeAccounts = createClaudeAccountsService({
  config: appConfigDb,
  fetch: globalThis.fetch,
  loginEmail: () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? null;
    } catch {
      return null;
    }
  },
});

/** Used by the Claude runtime to pick each run's credential and to record what API-key turns cost. */
export const claudeBilling = createClaudeBillingService({
  homeDirectory: os.homedir(),
  hostEnv: process.env,
  config: appConfigDb,
  spend: claudeApiSpendDb,
  usage: claudeApiUsageDb,
  readUsageLimits: () => usageService.getUsage().limits,
  accounts: claudeAccounts,
  creditCycleStart: () => claudeCredit.cycleStart(),
});

/**
 * Runs `claude -p` on Haiku with no tools, no MCP servers, no settings, hooks or CLAUDE.md, and no saved transcript,
 * from an empty folder, on the subscription login rather than an API key: the point is to start the plan's window.
 */
function sendContextlessPing(prompt: string): Promise<string> {
  const cwd = path.join(os.tmpdir(), 'cloudcli-workday-ping');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const args = ['-p', prompt, '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
    '--system-prompt', 'Reply briefly.', '--no-session-persistence'];
  return new Promise((resolve, reject) => {
    const child = execFile(resolveClaudeCodeExecutablePath() ?? 'claude', args, { cwd, env, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => (error ? reject(new Error(String(stderr).trim() || error.message)) : resolve(String(stdout))));
    // `-p` otherwise waits a few seconds for piped input before sending.
    child.stdin?.end();
  });
}

/** Used by the server entrypoint to start and stop the workday ping, and by the usage routes to configure it. */
export const workdayPing = createWorkdayPingService({ config: appConfigDb, sendPing: sendContextlessPing });

/** Used by the server entrypoint to mount the authenticated plan-usage endpoints. */
export const usageRoutes = createUsageRouter(usageService, usageLogin, claudeBilling, claudeCredit, workdayPing, claudeAccounts);
