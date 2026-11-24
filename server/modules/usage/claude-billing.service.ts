import fs from 'node:fs';
import path from 'node:path';

import type { ClaudeApiUsageRow } from '@/modules/database/index.js';

type UsageLimitReading = { kind: string; percent: number; resetsAt: number };

/** The subscriptions runs can be billed to, in the user's order; the CLI's own login has the id `login`. */
type ClaudeAccountSource = {
  order(): string[];
  /** The OAuth token a run on this account is launched with; null for the CLI login, and for an account that cannot be used now. */
  token(id: string): string | null;
  label(id: string): string;
  /** The account's own limit bars; the CLI login's come from `readUsageLimits`. */
  limits(id: string): UsageLimitReading[];
};

type ClaudeBillingDependencies = {
  homeDirectory: string;
  hostEnv: NodeJS.ProcessEnv;
  config: { get(key: string): string | null; set(key: string, value: string): void };
  spend: { record(costUsd: number, sessionId: string | null, at: number): void; sumSince(since: number): number };
  usage: { record(messageId: string, sessionId: string | null, usage: ClaudeApiUsageRow, at: number): void };
  /** The latest plan-usage reading of the CLI login, the same one the sidebar's bars show. */
  readUsageLimits: () => UsageLimitReading[];
  /** Extra subscriptions; without them the CLI login is the only one. */
  accounts?: ClaudeAccountSource;
  /** When the current API credit cycle began, in epoch milliseconds; spend is totalled from there. */
  creditCycleStart: () => number;
  now?: () => number;
};

type ApiKeyVariable = 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';

/** The subscription a run is billed to. `token` is null for the CLI's own login. */
export type ClaudeBillingAccount = { id: string; label: string; token: string | null };

/**
 * Which credential a run is launched with.
 * - `subscription`: a plan; every API-key variable is kept from the CLI, and an extra account's token is passed in.
 * - `api_key`: every plan is at a limit (or there is none), so the run is billed to `key`.
 * - `none`: no plan and no key; the env is passed through untouched.
 */
export type ClaudeBilling =
  | { mode: 'subscription'; account: ClaudeBillingAccount }
  | { mode: 'api_key'; variable: ApiKeyVariable; key: string; limit: ClaudeBillingLimit | null }
  | { mode: 'none' };

/** The subscription limit a fallback is waiting out; `resetsAt` is epoch milliseconds. */
export type ClaudeBillingLimit = { kind: string; resetsAt: number };

/** What `/api/usage` reports next to the limit bars. */
export type ClaudeBillingStatus = {
  keySource: 'settings' | 'environment' | null;
  keyHint: string | null;
  mode: ClaudeBilling['mode'];
  /** The subscription the next run goes to, when it goes to one. */
  account: { id: string; label: string } | null;
  /** A subscription login was there and has ended, as opposed to never having been set up. */
  loginExpired: boolean;
  /** On the key: the soonest reset among the plans. On a plan: that plan's limit, when it is at one. */
  limit: ClaudeBillingLimit | null;
  /** Every subscription in order, with the limit it is at. */
  accounts: { id: string; label: string; limit: ClaudeBillingLimit | null }[];
  /** The user allowed runs to move to the key once every plan is at a limit, until those limits reset. */
  armed: boolean;
  /** Every plan is at a limit or close enough that the sidebar offers the switch to the key. */
  canSwitch: boolean;
  spend: { today: number; cycle: number };
};

/**
 * What the runtime reports for the chat that should move:
 * - `limit-hit`: a turn on subscription `accountId` ended on the plan's limit message.
 * - `subscription-back`: a turn billed to `accountId` (`api` for the key) is at a point where it can stop, and a
 *   subscription earlier in the order has room again.
 */
export type ClaudeBillingSwitchEvent = { type: 'limit-hit' | 'subscription-back'; sessionId: string; accountId: string };

/** The account id a process billed to the key runs under. */
export const API_KEY_ACCOUNT_ID = 'api';
const LOGIN_ACCOUNT_ID = 'login';

const STORED_KEY = 'claude_fallback_api_key';
const LIMITS_KEY = 'claude_subscription_limits';
const ARMED_KEY = 'claude_api_fallback_armed';
const API_KEY_VARIABLES: ApiKeyVariable[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

// The limit-bar kinds that stop the plan outright once full. Model-scoped weekly caps only block that model.
const BLOCKING_KINDS = new Set(['session', 'weekly_all', 'five_hour', 'seven_day']);
const SWITCH_OFFER_PERCENT = 90;
const SESSION_WINDOW_MS = 5 * 3_600_000;

type RateLimitInfo = { status?: string; rateLimitType?: string; resetsAt?: number };

/** The CLI reports seconds. */
function toMilliseconds(epoch: number): number {
  return epoch < 1e12 ? epoch * 1000 : epoch;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const LOGIN_ONLY: ClaudeAccountSource = { order: () => [LOGIN_ACCOUNT_ID], token: () => null, label: () => 'Claude login', limits: () => [] };

/**
 * Decides per run which credential Claude is billed to. The subscriptions go first, in the user's order: a run
 * takes the first one at no limit. Once every one is at a limit, the key is used only if the user armed the
 * switch, and only until the first of those limits resets. Without any subscription the key is used outright.
 */
export function createClaudeBillingService(dependencies: ClaudeBillingDependencies) {
  const now = dependencies.now ?? Date.now;
  const { config, hostEnv } = dependencies;
  const accounts = dependencies.accounts ?? LOGIN_ONLY;

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

  function storedLogin(): { accessToken?: string; refreshToken?: string } | null {
    return readJson(path.join(dependencies.homeDirectory, '.claude', '.credentials.json'))?.claudeAiOauth ?? null;
  }

  function hasLogin(): boolean {
    if (hostEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
    const login = storedLogin();
    return Boolean(login?.accessToken || login?.refreshToken);
  }

  /** Whether the account can be launched at all, at a limit or not. */
  function signedIn(id: string): boolean {
    return id === LOGIN_ACCOUNT_ID ? hasLogin() : accounts.token(id) !== null;
  }

  function signedInAccounts(): string[] {
    return accounts.order().filter(signedIn);
  }

  /** The CLI keeps the login entry and empties its tokens when a login ends, so an entry without tokens is one that ran out. */
  function loginExpired(): boolean {
    return !hasLogin() && storedLogin() !== null;
  }

  function usageLimits(id: string): UsageLimitReading[] {
    return id === LOGIN_ACCOUNT_ID ? dependencies.readUsageLimits() : accounts.limits(id);
  }

  function storedLimits(): Record<string, ClaudeBillingLimit> {
    try {
      const parsed = JSON.parse(config.get(LIMITS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** The limit the account is at right now, from a live rejection or a full bar, whichever resets last. */
  function currentLimit(id: string): ClaudeBillingLimit | null {
    const at = now();
    const candidates: ClaudeBillingLimit[] = [];
    const rejected = storedLimits()[id];
    if (Number.isFinite(rejected?.resetsAt) && rejected.resetsAt > at) candidates.push({ kind: String(rejected.kind || 'session'), resetsAt: rejected.resetsAt });
    for (const limit of usageLimits(id)) {
      if (BLOCKING_KINDS.has(limit.kind) && limit.percent >= 100 && limit.resetsAt > at) candidates.push({ kind: limit.kind, resetsAt: limit.resetsAt });
    }
    if (!candidates.length) return null;
    return candidates.reduce((latest, limit) => (limit.resetsAt > latest.resetsAt ? limit : latest));
  }

  /** The latest reset among the account's blocking bars at or past the offer threshold, or null when none is that full. */
  function nearLimitReset(id: string): number | null {
    const at = now();
    const resets = usageLimits(id)
      .filter((limit) => BLOCKING_KINDS.has(limit.kind) && limit.percent >= SWITCH_OFFER_PERCENT && limit.resetsAt > at)
      .map((limit) => limit.resetsAt);
    return resets.length ? Math.max(...resets) : null;
  }

  function available(id: string): boolean {
    return signedIn(id) && !currentLimit(id);
  }

  /** The soonest any plan is back, which is how long a run on the key waits. */
  function soonestReset(): ClaudeBillingLimit | null {
    const limits = signedInAccounts().map(currentLimit).filter((limit): limit is ClaudeBillingLimit => limit !== null);
    if (!limits.length) return null;
    return limits.reduce((soonest, limit) => (limit.resetsAt < soonest.resetsAt ? limit : soonest));
  }

  function armedUntil(): number | null {
    const until = Number(config.get(ARMED_KEY));
    return until > now() ? until : null;
  }

  /** Arming lasts until the limits the plans are at or near reset, so the next window asks again. */
  function setArmed(armed: boolean): void {
    if (!armed) {
      config.set(ARMED_KEY, '');
      return;
    }
    const resets = signedInAccounts().map((id) => Math.max(currentLimit(id)?.resetsAt ?? 0, nearLimitReset(id) ?? 0));
    const until = (resets.length ? Math.max(...resets) : 0) || now() + SESSION_WINDOW_MS;
    config.set(ARMED_KEY, String(until));
  }

  /** A limit hit while armed keeps the arming for as long as that limit lasts. */
  function extendArming(resetsAt: number): void {
    const until = armedUntil();
    if (until && resetsAt > until) config.set(ARMED_KEY, String(resetsAt));
  }

  /** True when an account earlier in the order than `accountId` has room; for the key, when any account has. */
  function betterAccountAvailable(accountId: string): boolean {
    const order = accounts.order();
    const position = accountId === API_KEY_ACCOUNT_ID ? order.length : order.indexOf(accountId);
    return order.slice(0, position < 0 ? order.length : position).some(available);
  }

  /** True when the account is at a limit, so a process on it cannot reach the model. The key never is. */
  function accountBlocked(accountId: string): boolean {
    return accountId !== API_KEY_ACCOUNT_ID && !available(accountId);
  }

  const switchListeners = new Set<(event: ClaudeBillingSwitchEvent) => void>();

  function onSwitch(listener: (event: ClaudeBillingSwitchEvent) => void): () => void {
    switchListeners.add(listener);
    return () => { switchListeners.delete(listener); };
  }

  function emitSwitch(event: ClaudeBillingSwitchEvent): void {
    for (const listener of switchListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[ClaudeBilling] switch listener failed:', error instanceof Error ? error.message : error);
      }
    }
  }

  function toAccount(id: string): ClaudeBillingAccount {
    return { id, label: accounts.label(id), token: id === LOGIN_ACCOUNT_ID ? null : accounts.token(id) };
  }

  function resolve(): ClaudeBilling {
    const key = fallbackKey();
    const signed = signedInAccounts();
    if (!signed.length) return key ? { mode: 'api_key', ...key, limit: null } : { mode: 'none' };
    const free = signed.find((id) => !currentLimit(id));
    if (free) return { mode: 'subscription', account: toAccount(free) };
    if (key && armedUntil()) return { mode: 'api_key', ...key, limit: soonestReset() };
    // Every plan is at a limit and the key is not allowed: the first one in the order answers with its limit.
    return { mode: 'subscription', account: toAccount(signed[0]) };
  }

  /**
   * Feeds a `rate_limit_event` from a run on subscription `accountId`. A rejection is remembered until its reset,
   * so the next run goes to the next subscription at once instead of failing against this one first.
   */
  function noteRateLimit(info: RateLimitInfo | null | undefined, accountId: string = LOGIN_ACCOUNT_ID): void {
    if (info?.status !== 'rejected' || info.rateLimitType === 'overage' || !info.resetsAt) return;
    rememberLimit(accountId, info.rateLimitType || 'five_hour', toMilliseconds(info.resetsAt));
  }

  /**
   * Feeds the plan's limit message ("You've hit your limit") that ended a turn of `sessionId` on `accountId`. The
   * CLI does not always send a rejected `rate_limit_event` first, so the reset comes from the last event the run
   * saw, else from the account's fullest blocking bar, else an hour out so the plan is tried again soon.
   */
  function noteLimitHit(lastInfo: RateLimitInfo | null | undefined, sessionId: string | null, accountId: string = LOGIN_ACCOUNT_ID): void {
    const fromEvent = lastInfo?.resetsAt && lastInfo.rateLimitType !== 'overage' ? toMilliseconds(lastInfo.resetsAt) : 0;
    const resetsAt = fromEvent > now() ? fromEvent : nearLimitReset(accountId) ?? now() + 3_600_000;
    rememberLimit(accountId, lastInfo?.rateLimitType && lastInfo.rateLimitType !== 'overage' ? lastInfo.rateLimitType : 'five_hour', resetsAt);
    if (sessionId) emitSwitch({ type: 'limit-hit', sessionId, accountId });
  }

  /** Called by a run on `accountId` once it can stop, which `betterAccountAvailable` must say is worth it. */
  function noteSubscriptionBack(sessionId: string, accountId: string): void {
    emitSwitch({ type: 'subscription-back', sessionId, accountId });
  }

  function rememberLimit(accountId: string, kind: string, resetsAt: number): void {
    config.set(LIMITS_KEY, JSON.stringify({ ...storedLimits(), [accountId]: { kind, resetsAt } }));
    extendArming(resetsAt);
  }

  function recordSpend(costUsd: number, sessionId: string | null): void {
    if (costUsd > 0) dependencies.spend.record(costUsd, sessionId, now());
  }

  /** Feeds an `assistant` message's model and usage from a run billed to the key, in the dimensions the usage report prices by. */
  function recordUsage(message: { id?: string; model?: string; usage?: Record<string, any> } | null | undefined, sessionId: string | null): void {
    const usage = message?.usage;
    if (!message?.id || !message.model || !usage) return;
    const contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    dependencies.usage.record(message.id, sessionId, {
      model: message.model,
      context_window: contextTokens > 200_000 ? '200k-1M' : '0-200k',
      service_tier: usage.service_tier ?? 'standard',
      speed: usage.speed ?? 'standard',
      uncached_input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        ephemeral_1h_input_tokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
      server_tool_use: { web_search_requests: usage.server_tool_use?.web_search_requests ?? 0 },
    }, now());
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
    const signed = signedInAccounts();
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);
    return {
      keySource: stored ? 'settings' : key ? 'environment' : null,
      keyHint: key ? key.slice(-4) : null,
      mode: billing.mode,
      account: billing.mode === 'subscription' ? { id: billing.account.id, label: billing.account.label } : null,
      loginExpired: loginExpired(),
      limit: billing.mode === 'api_key' ? billing.limit : billing.mode === 'subscription' ? currentLimit(billing.account.id) : null,
      accounts: accounts.order().map((id) => ({ id, label: accounts.label(id), limit: currentLimit(id) })),
      armed: armedUntil() !== null,
      canSwitch: Boolean(key) && signed.length > 0 && signed.every((id) => currentLimit(id) || nearLimitReset(id)),
      spend: { today: dependencies.spend.sumSince(today.getTime()), cycle: dependencies.spend.sumSince(dependencies.creditCycleStart()) },
    };
  }

  /**
   * The cost total a CLI resuming `sessionId` in `cwd` starts from. The CLI saves the last session's total per folder
   * in `~/.claude.json` and carries it on when that same session is resumed, so its first `total_cost_usd` already
   * holds what earlier processes spent.
   */
  function restoredCostTotal(cwd: string, sessionId: string): number {
    const projects = readJson(path.join(dependencies.homeDirectory, '.claude.json'))?.projects ?? {};
    const folder = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const entry = Object.entries(projects).find(([key]) => key.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === folder)?.[1] as
      { lastSessionId?: string; lastCost?: number } | undefined;
    return entry?.lastSessionId === sessionId && Number.isFinite(entry.lastCost) ? entry.lastCost! : 0;
  }

  return {
    resolve, noteRateLimit, noteLimitHit, noteSubscriptionBack, betterAccountAvailable, accountBlocked, onSwitch, setArmed,
    recordSpend, recordUsage, restoredCostTotal, setKey, clearKey, getStatus,
  };
}

/** The account id a process launched as `billing` runs under, or null when it runs on neither a plan nor the key. */
export function claudeBillingAccountId(billing: ClaudeBilling): string | null {
  if (billing.mode === 'subscription') return billing.account.id;
  return billing.mode === 'api_key' ? API_KEY_ACCOUNT_ID : null;
}

/**
 * The CLI's environment for a run billed as `billing` says. Claude Code prefers an API-key variable over the
 * subscription login whenever one is set, so a subscription run must not see any; an extra subscription is
 * passed as `CLAUDE_CODE_OAUTH_TOKEN`, which the CLI prefers over its own login.
 */
export function applyClaudeBillingEnv(env: NodeJS.ProcessEnv, billing: ClaudeBilling): NodeJS.ProcessEnv {
  if (billing.mode === 'none') return env;
  const result = { ...env };
  for (const variable of API_KEY_VARIABLES) delete result[variable];
  if (billing.mode === 'api_key') result[billing.variable] = billing.key;
  if (billing.mode === 'subscription' && billing.account.token) result.CLAUDE_CODE_OAUTH_TOKEN = billing.account.token;
  return result;
}
