import fs from 'node:fs';
import path from 'node:path';

import type { ClaudeApiUsageRow } from '@/modules/database/index.js';

type UsageLimitReading = { kind: string; percent: number; resetsAt: number };

type ClaudeBillingDependencies = {
  homeDirectory: string;
  hostEnv: NodeJS.ProcessEnv;
  config: { get(key: string): string | null; set(key: string, value: string): void };
  spend: { record(costUsd: number, sessionId: string | null, at: number): void; sumSince(since: number): number };
  usage: { record(messageId: string, sessionId: string | null, usage: ClaudeApiUsageRow, at: number): void };
  /** The latest plan-usage reading, the same one the sidebar's bars show. */
  readUsageLimits: () => UsageLimitReading[];
  /** When the current API credit cycle began, in epoch milliseconds; spend is totalled from there. */
  creditCycleStart: () => number;
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
  /** A subscription login was there and has ended, as opposed to never having been set up. */
  loginExpired: boolean;
  limit: ClaudeBillingLimit | null;
  /** The user allowed runs to move to the key at a plan limit, until the limit they were near resets. */
  armed: boolean;
  /** A plan limit is hit or close enough that the sidebar offers the switch to the key. */
  canSwitch: boolean;
  spend: { today: number; cycle: number };
};

/**
 * What the runtime reports for the chat that should move:
 * - `limit-hit`: a subscription turn ended on the plan's limit message.
 * - `subscription-back`: a turn billed to the key is at a point where it can stop, and the plan has room again.
 */
export type ClaudeBillingSwitchEvent = { type: 'limit-hit' | 'subscription-back'; sessionId: string };

const STORED_KEY = 'claude_fallback_api_key';
const LIMIT_KEY = 'claude_subscription_limit';
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

/**
 * Decides per run whether Claude is billed to the subscription or to an API key. The subscription always
 * goes first; at a plan limit the key is used only once the user armed the switch, and only until that
 * limit's reset. Without a subscription login the key is used outright.
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

  function storedLogin(): { accessToken?: string; refreshToken?: string } | null {
    return readJson(path.join(dependencies.homeDirectory, '.claude', '.credentials.json'))?.claudeAiOauth ?? null;
  }

  function hasSubscription(): boolean {
    if (hostEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
    const login = storedLogin();
    return Boolean(login?.accessToken || login?.refreshToken);
  }

  /** The CLI keeps the login entry and empties its tokens when a login ends, so an entry without tokens is one that ran out. */
  function loginExpired(): boolean {
    return !hasSubscription() && storedLogin() !== null;
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

  /** The latest reset among the blocking bars at or past the offer threshold, or null when none is that full. */
  function nearLimitReset(): number | null {
    const at = now();
    const resets = dependencies.readUsageLimits()
      .filter((limit) => BLOCKING_KINDS.has(limit.kind) && limit.percent >= SWITCH_OFFER_PERCENT && limit.resetsAt > at)
      .map((limit) => limit.resetsAt);
    return resets.length ? Math.max(...resets) : null;
  }

  function armedUntil(): number | null {
    const until = Number(config.get(ARMED_KEY));
    return until > now() ? until : null;
  }

  /** Arming lasts until the limit the plan is at or near resets, so the next window asks again. */
  function setArmed(armed: boolean): void {
    if (!armed) {
      config.set(ARMED_KEY, '');
      return;
    }
    const until = Math.max(currentLimit()?.resetsAt ?? 0, nearLimitReset() ?? 0) || now() + SESSION_WINDOW_MS;
    config.set(ARMED_KEY, String(until));
  }

  /** A limit hit while armed keeps the arming for as long as that limit lasts. */
  function extendArming(resetsAt: number): void {
    const until = armedUntil();
    if (until && resetsAt > until) config.set(ARMED_KEY, String(resetsAt));
  }

  /** True when the plan can take a run again: logged in and at no limit. */
  function subscriptionAvailable(): boolean {
    return hasSubscription() && !currentLimit();
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
    if (limit && key && armedUntil()) return { mode: 'api_key', ...key, limit };
    return { mode: 'subscription' };
  }

  /**
   * Feeds a `rate_limit_event` from a subscription run. A rejection is remembered until its reset, so the
   * next run goes to the key at once instead of failing against the plan first.
   */
  function noteRateLimit(info: RateLimitInfo | null | undefined): void {
    if (info?.status !== 'rejected' || info.rateLimitType === 'overage' || !info.resetsAt) return;
    rememberLimit(info.rateLimitType || 'five_hour', toMilliseconds(info.resetsAt));
  }

  /**
   * Feeds the plan's limit message ("You've hit your limit") that ended a subscription turn of `sessionId`. The
   * CLI does not always send a rejected `rate_limit_event` first, so the reset comes from the last event the run
   * saw, else from the fullest blocking bar, else an hour out so the plan is tried again soon.
   */
  function noteLimitHit(lastInfo: RateLimitInfo | null | undefined, sessionId: string | null): void {
    const fromEvent = lastInfo?.resetsAt && lastInfo.rateLimitType !== 'overage' ? toMilliseconds(lastInfo.resetsAt) : 0;
    const resetsAt = fromEvent > now() ? fromEvent : nearLimitReset() ?? now() + 3_600_000;
    rememberLimit(lastInfo?.rateLimitType && lastInfo.rateLimitType !== 'overage' ? lastInfo.rateLimitType : 'five_hour', resetsAt);
    if (sessionId) emitSwitch({ type: 'limit-hit', sessionId });
  }

  /** Called by a run billed to the key once it can stop for the plan, which `subscriptionAvailable` must say is back. */
  function noteSubscriptionBack(sessionId: string): void {
    emitSwitch({ type: 'subscription-back', sessionId });
  }

  function rememberLimit(kind: string, resetsAt: number): void {
    config.set(LIMIT_KEY, JSON.stringify({ kind, resetsAt }));
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
    const limit = billing.mode === 'api_key' ? billing.limit : currentLimit();
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);
    return {
      keySource: stored ? 'settings' : key ? 'environment' : null,
      keyHint: key ? key.slice(-4) : null,
      mode: billing.mode,
      loginExpired: loginExpired(),
      limit,
      armed: armedUntil() !== null,
      canSwitch: Boolean(key) && hasSubscription() && Boolean(limit || nearLimitReset()),
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
    resolve, noteRateLimit, noteLimitHit, noteSubscriptionBack, subscriptionAvailable, onSwitch, setArmed,
    recordSpend, recordUsage, restoredCostTotal, setKey, clearKey, getStatus,
  };
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
