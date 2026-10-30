import fs from 'node:fs';
import path from 'node:path';

type UsageLimitReading = { kind: string; percent: number; resetsAt: number };

type ClaudeBillingDependencies = {
  homeDirectory: string;
  hostEnv: NodeJS.ProcessEnv;
  config: { get(key: string): string | null; set(key: string, value: string): void };
  spend: { record(costUsd: number, sessionId: string | null, at: number): void; sumSince(since: number): number };
  /** The latest plan-usage reading, the same one the sidebar's bars show. */
  readUsageLimits: () => UsageLimitReading[];
  now?: () => number;
};

type ApiKeyVariable = 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';

/**
 * Which credential a run is launched with.
 * - `subscription`: the `claude /login` plan; every API-key variable is kept from the CLI.
 * - `api_key`: the plan is at a limit (or there is none), so the run is billed to `key`.
 * - `none`: no plan and no key; the env is passed through untouched.
 */
export type ClaudeBilling =
  | { mode: 'subscription' }
  | { mode: 'api_key'; variable: ApiKeyVariable; key: string; limit: ClaudeBillingLimit | null }
  | { mode: 'none' };

/** The subscription limit a fallback is waiting out; `resetsAt` is epoch milliseconds. */
export type ClaudeBillingLimit = { kind: string; resetsAt: number };

/** What `/api/usage` reports next to the limit bars. */
export type ClaudeBillingStatus = {
  keySource: 'settings' | 'environment' | null;
  keyHint: string | null;
  mode: ClaudeBilling['mode'];
  limit: ClaudeBillingLimit | null;
  spend: { today: number; month: number };
};

const STORED_KEY = 'claude_fallback_api_key';
const LIMIT_KEY = 'claude_subscription_limit';
const API_KEY_VARIABLES: ApiKeyVariable[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// The limit-bar kinds that stop the plan outright once full. Model-scoped weekly caps only block that model.
const BLOCKING_KINDS = new Set(['session', 'weekly_all', 'five_hour', 'seven_day']);

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Decides per run whether Claude is billed to the subscription or to an API key. The subscription always
 * goes first; the key is used only while the plan reports a limit hit, until that limit's reset.
 */
export function createClaudeBillingService(dependencies: ClaudeBillingDependencies) {
  const now = dependencies.now ?? Date.now;
  const { config, hostEnv } = dependencies;

  function storedKey(): string | null {
    return config.get(STORED_KEY)?.trim() || null;
  }

  function hostKey(): { variable: ApiKeyVariable; key: string } | null {
    for (const variable of API_KEY_VARIABLES) {
      const key = hostEnv[variable]?.trim();
      if (key) return { variable, key };
    }
    return null;
  }

  /** The stored key wins over one in the server's environment, which is kept as a fallback for setups that had one. */
  function fallbackKey(): { variable: ApiKeyVariable; key: string } | null {
    const key = storedKey();
    return key ? { variable: 'ANTHROPIC_API_KEY', key } : hostKey();
  }

  function hasSubscription(): boolean {
    if (hostEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
    const oauth = readJson(path.join(dependencies.homeDirectory, '.claude', '.credentials.json'))?.claudeAiOauth;
    return Boolean(oauth?.accessToken || oauth?.refreshToken);
  }

  /** The limit the plan is at right now, from a live rejection or a full bar, whichever resets last. */
  function currentLimit(): ClaudeBillingLimit | null {
    const at = now();
    const candidates: ClaudeBillingLimit[] = [];
    const rejected = parseLimit(config.get(LIMIT_KEY));
    if (rejected && rejected.resetsAt > at) candidates.push(rejected);
    for (const limit of dependencies.readUsageLimits()) {
      if (BLOCKING_KINDS.has(limit.kind) && limit.percent >= 100 && limit.resetsAt > at) candidates.push({ kind: limit.kind, resetsAt: limit.resetsAt });
    }
    if (!candidates.length) return null;
    return candidates.reduce((latest, limit) => (limit.resetsAt > latest.resetsAt ? limit : latest));
  }

  function parseLimit(value: string | null): ClaudeBillingLimit | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return Number.isFinite(parsed?.resetsAt) ? { kind: String(parsed.kind || 'session'), resetsAt: parsed.resetsAt } : null;
    } catch {
      return null;
    }
  }

  function resolve(): ClaudeBilling {
    const key = fallbackKey();
    if (!hasSubscription()) return key ? { mode: 'api_key', ...key, limit: null } : { mode: 'none' };
    const limit = currentLimit();
    if (limit && key) return { mode: 'api_key', ...key, limit };
    return { mode: 'subscription' };
  }

  /**
   * Feeds a `rate_limit_event` from a subscription run. A rejection is remembered until its reset, so the
   * next run goes to the key at once instead of failing against the plan first.
   */
  function noteRateLimit(info: { status?: string; rateLimitType?: string; resetsAt?: number } | null | undefined): void {
    if (info?.status !== 'rejected' || info.rateLimitType === 'overage' || !info.resetsAt) return;
    // The CLI reports seconds.
    const resetsAt = info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt;
    config.set(LIMIT_KEY, JSON.stringify({ kind: info.rateLimitType || 'five_hour', resetsAt }));
  }

  function recordSpend(costUsd: number, sessionId: string | null): void {
    if (costUsd > 0) dependencies.spend.record(costUsd, sessionId, now());
  }

  function setKey(key: string): void {
    config.set(STORED_KEY, key.trim());
  }

  function clearKey(): void {
    config.set(STORED_KEY, '');
  }

  function getStatus(): ClaudeBillingStatus {
    const stored = storedKey();
    const key = stored ?? hostKey()?.key ?? null;
    const billing = resolve();
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);
    const month = new Date(today.getFullYear(), today.getMonth(), 1);
    return {
      keySource: stored ? 'settings' : key ? 'environment' : null,
      keyHint: key ? key.slice(-4) : null,
      mode: billing.mode,
      limit: billing.mode === 'api_key' ? billing.limit : currentLimit(),
      spend: { today: dependencies.spend.sumSince(today.getTime()), month: dependencies.spend.sumSince(month.getTime()) },
    };
  }

  return { resolve, noteRateLimit, recordSpend, setKey, clearKey, getStatus };
}

/**
 * The CLI's environment for a run billed as `billing` says. Claude Code prefers an API-key variable over the
 * subscription login whenever one is set, so a subscription run must not see any.
 */
export function applyClaudeBillingEnv(env: NodeJS.ProcessEnv, billing: ClaudeBilling): NodeJS.ProcessEnv {
  if (billing.mode === 'none') return env;
  const result = { ...env };
  for (const variable of API_KEY_VARIABLES) delete result[variable];
  if (billing.mode === 'api_key') result[billing.variable] = billing.key;
  return result;
}
