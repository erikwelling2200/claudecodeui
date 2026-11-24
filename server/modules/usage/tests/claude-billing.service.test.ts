import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyClaudeBillingEnv, createClaudeBillingService } from '../claude-billing.service.js';

const NOW = Date.parse('2026-10-29T14:00:00Z');
const HOUR = 3_600_000;

type Options = {
  loggedIn?: boolean;
  storedKey?: string;
  hostEnv?: NodeJS.ProcessEnv;
  limits?: { kind: string; percent: number; resetsAt: number }[];
  cycleStart?: number;
  /** Extra subscriptions after the CLI login, each with its token and bars. */
  extra?: { id: string; token: string | null; limits?: { kind: string; percent: number; resetsAt: number }[] }[];
  order?: string[];
};

function createBilling(options: Options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  if (options.loggedIn !== false) {
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  }
  const config = new Map<string, string>(options.storedKey ? [['claude_fallback_api_key', options.storedKey]] : []);
  const ledger: { costUsd: number; at: number }[] = [];
  const usage = new Map<string, unknown>();
  let clock = NOW;
  const billing = createClaudeBillingService({
    homeDirectory: home,
    hostEnv: options.hostEnv ?? {},
    config: { get: (key) => config.get(key) ?? null, set: (key, value) => { config.set(key, value); } },
    spend: {
      record: (costUsd, _sessionId, at) => { ledger.push({ costUsd, at }); },
      sumSince: (since) => ledger.filter((row) => row.at >= since).reduce((sum, row) => sum + row.costUsd, 0),
    },
    usage: { record: (messageId, _sessionId, row, at) => { usage.set(messageId, { ...row, at }); } },
    readUsageLimits: () => options.limits ?? [],
    accounts: {
      order: () => options.order ?? ['login', ...(options.extra ?? []).map((account) => account.id)],
      token: (id) => options.extra?.find((account) => account.id === id)?.token ?? null,
      label: (id) => id,
      limits: (id) => options.extra?.find((account) => account.id === id)?.limits ?? [],
    },
    creditCycleStart: () => options.cycleStart ?? Date.parse('2026-10-20T00:00:00Z'),
    now: () => clock,
  });
  return { billing, home, usage, advance: (ms: number) => { clock += ms; } };
}

test("a response's usage is recorded in the usage report's dimensions, its context window from the whole prompt", () => {
  const { billing, usage } = createBilling();
  billing.recordUsage({
    id: 'msg_1',
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 10, cache_read_input_tokens: 199_600, cache_creation_input_tokens: 500, output_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 },
      server_tool_use: { web_search_requests: 1 }, service_tier: 'standard', speed: 'standard',
    },
  }, 'session-1');
  billing.recordUsage({ id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 5, output_tokens: 1 } }, 'session-1');
  billing.recordUsage({ model: 'claude-opus-5-5', usage: { input_tokens: 5 } }, 'session-1');
  assert.deepEqual(usage.get('msg_1'), {
    model: 'claude-opus-5-5', context_window: '200k-1M', service_tier: 'standard', speed: 'standard',
    uncached_input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 199_600,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }, server_tool_use: { web_search_requests: 1 }, at: NOW,
  });
  assert.equal((usage.get('msg_2') as { context_window: string }).context_window, '0-200k');
  assert.equal(usage.size, 2);
});

test('the subscription is used while it has room, even with a key stored', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored' });
  assert.equal(billing.resolve().mode, 'subscription');
});

test('an armed switch moves runs to the stored key at a rejected limit, until it resets', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored' });
  billing.setArmed(true);
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 });
  assert.deepEqual(billing.resolve(), { mode: 'api_key', variable: 'ANTHROPIC_API_KEY', key: 'sk-stored', limit: { kind: 'five_hour', resetsAt: NOW + HOUR } });
  advance(HOUR);
  assert.equal(billing.resolve().mode, 'subscription');
});

test('a full session bar moves runs to the key before any run has been rejected, once armed', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 100, resetsAt: NOW + HOUR }] });
  billing.setArmed(true);
  assert.equal(billing.resolve().mode, 'api_key');
});

test('a full model-scoped weekly bar does not, since other models still run on the plan', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'weekly_opus', percent: 100, resetsAt: NOW + HOUR }] });
  billing.setArmed(true);
  assert.equal(billing.resolve().mode, 'subscription');
});

test('warnings and overage events do not count as a limit hit', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored' });
  billing.setArmed(true);
  billing.noteRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 });
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'overage', resetsAt: (NOW + HOUR) / 1000 });
  assert.equal(billing.resolve().mode, 'subscription');
});

test('a limit hit stays on the subscription until the switch is armed', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 100, resetsAt: NOW + HOUR }] });
  assert.equal(billing.resolve().mode, 'subscription');
  assert.deepEqual([billing.getStatus().canSwitch, billing.getStatus().armed], [true, false]);
  billing.setArmed(true);
  assert.deepEqual([billing.resolve().mode, billing.getStatus().armed], ['api_key', true]);
  billing.setArmed(false);
  assert.equal(billing.resolve().mode, 'subscription');
});

test('the switch is offered from 90% of a blocking bar, and arming it lasts until that bar resets', () => {
  const near = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 90, resetsAt: NOW + 2 * HOUR }] });
  assert.equal(near.billing.getStatus().canSwitch, true);
  near.billing.setArmed(true);
  near.advance(2 * HOUR);
  assert.equal(near.billing.getStatus().armed, false);
  assert.equal(createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 89, resetsAt: NOW + HOUR }] }).billing.getStatus().canSwitch, false);
  assert.equal(createBilling({ limits: [{ kind: 'session', percent: 95, resetsAt: NOW + HOUR }] }).billing.getStatus().canSwitch, false);
});

test("the plan's limit message records the limit from the run's last rate-limit event and reports the chat", () => {
  const { billing } = createBilling({ storedKey: 'sk-stored' });
  const events: unknown[] = [];
  billing.onSwitch((event) => { events.push(event); });
  billing.setArmed(true);
  billing.noteLimitHit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: (NOW + 3 * HOUR) / 1000 }, 'chat-1');
  assert.deepEqual(billing.getStatus().limit, { kind: 'five_hour', resetsAt: NOW + 3 * HOUR });
  assert.equal(billing.resolve().mode, 'api_key');
  assert.equal(billing.betterAccountAvailable('api'), false);
  assert.deepEqual(events, [{ type: 'limit-hit', sessionId: 'chat-1', accountId: 'login' }]);
});

test('a limit message without an event falls back to the fullest bar, and the plan is available again after it', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 97, resetsAt: NOW + 2 * HOUR }] });
  billing.noteLimitHit(null, null);
  assert.deepEqual(billing.getStatus().limit, { kind: 'five_hour', resetsAt: NOW + 2 * HOUR });
  advance(2 * HOUR);
  assert.equal(billing.betterAccountAvailable('api'), true);
});

test('without a key a limit hit stays on the subscription', () => {
  const { billing } = createBilling();
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 });
  assert.equal(billing.resolve().mode, 'subscription');
  assert.deepEqual(billing.getStatus().limit, { kind: 'five_hour', resetsAt: NOW + HOUR });
});

test('a key in the server env is the fallback when none is stored, and the stored one wins over it', () => {
  const hostEnv = { ANTHROPIC_AUTH_TOKEN: 'env-token' };
  const limits = [{ kind: 'session', percent: 100, resetsAt: NOW + HOUR }];
  const armed = (options: Options) => { const { billing } = createBilling(options); billing.setArmed(true); return billing; };
  assert.deepEqual(armed({ hostEnv, limits }).resolve(), { mode: 'api_key', variable: 'ANTHROPIC_AUTH_TOKEN', key: 'env-token', limit: { kind: 'session', resetsAt: NOW + HOUR } });
  assert.equal((armed({ hostEnv, limits, storedKey: 'sk-stored' }).resolve() as { key: string }).key, 'sk-stored');
});

test('with no subscription login a key is used outright, and with neither the env is left alone', () => {
  assert.equal(createBilling({ loggedIn: false, storedKey: 'sk-stored' }).billing.resolve().mode, 'api_key');
  assert.deepEqual(createBilling({ loggedIn: false }).billing.resolve(), { mode: 'none' });
});

test('a login entry left without tokens is reported as expired, a missing one is not', () => {
  const ended = createBilling({ loggedIn: false, storedKey: 'sk-stored' });
  fs.writeFileSync(path.join(ended.home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', loginEnded: 'time_limit' } }));
  assert.deepEqual([ended.billing.getStatus().mode, ended.billing.getStatus().loginExpired], ['api_key', true]);
  assert.equal(createBilling({ loggedIn: false, storedKey: 'sk-stored' }).billing.getStatus().loginExpired, false);
  assert.equal(createBilling({ storedKey: 'sk-stored' }).billing.getStatus().loginExpired, false);
});

test('a resumed session starts from the cost the CLI saved for it, any other session from zero', () => {
  const { billing, home } = createBilling();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { 'C:/Work/app': { lastSessionId: 's1', lastCost: 22.1 } } }));
  assert.equal(billing.restoredCostTotal('C:\\Work\\app', 's1'), 22.1);
  assert.equal(billing.restoredCostTotal('C:\\Work\\app', 's2'), 0);
  assert.equal(billing.restoredCostTotal('C:\\Work\\other', 's1'), 0);
});

test('the env for a subscription run carries no key; for a key run only the chosen one', () => {
  const env = { PATH: 'x', ANTHROPIC_API_KEY: 'env-key', ANTHROPIC_AUTH_TOKEN: 'env-token' };
  assert.deepEqual(applyClaudeBillingEnv(env, { mode: 'subscription', account: { id: 'login', label: 'me', token: null } }), { PATH: 'x' });
  assert.deepEqual(applyClaudeBillingEnv(env, { mode: 'subscription', account: { id: 'b', label: 'b', token: 'oauth-b' } }), { PATH: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-b' });
  assert.deepEqual(applyClaudeBillingEnv(env, { mode: 'api_key', variable: 'ANTHROPIC_API_KEY', key: 'sk-stored', limit: null }), { PATH: 'x', ANTHROPIC_API_KEY: 'sk-stored' });
  assert.equal(applyClaudeBillingEnv(env, { mode: 'none' }), env);
});

test('spend is totalled for today and since the credit cycle began', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored' });
  billing.recordSpend(1.25, 's1');
  billing.recordSpend(0, 's1');
  advance(-3 * 24 * HOUR);
  billing.recordSpend(2, 's2');
  advance(-7 * 24 * HOUR);
  billing.recordSpend(4, 's3');
  advance(10 * 24 * HOUR);
  assert.deepEqual(billing.getStatus().spend, { today: 1.25, cycle: 3.25 });
  assert.equal(billing.getStatus().keyHint, 'ored');
  assert.equal(billing.getStatus().keySource, 'settings');
});

test('a run takes the first subscription in the order with room, and the key only once every one is full and armed', () => {
  const full = [{ kind: 'session', percent: 100, resetsAt: NOW + HOUR }];
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: full, extra: [{ id: 'b', token: 'oauth-b' }, { id: 'c', token: 'oauth-c' }] });
  assert.deepEqual(billing.resolve(), { mode: 'subscription', account: { id: 'b', label: 'b', token: 'oauth-b' } });
  billing.noteLimitHit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + 2 * HOUR) / 1000 }, 'chat', 'b');
  assert.equal((billing.resolve() as { account: { id: string } }).account.id, 'c');
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + 3 * HOUR) / 1000 }, 'c');
  assert.equal(billing.getStatus().canSwitch, true);
  assert.deepEqual(billing.resolve(), { mode: 'subscription', account: { id: 'login', label: 'login', token: null } });
  billing.setArmed(true);
  assert.deepEqual(billing.resolve(), { mode: 'api_key', variable: 'ANTHROPIC_API_KEY', key: 'sk-stored', limit: { kind: 'session', resetsAt: NOW + HOUR } });
});

test('the order decides, and an account without a usable token is skipped', () => {
  const { billing } = createBilling({ order: ['b', 'login', 'c'], extra: [{ id: 'b', token: null }, { id: 'c', token: 'oauth-c' }] });
  assert.equal((billing.resolve() as { account: { id: string } }).account.id, 'login');
});

test('a better subscription is one earlier in the order with room; for the key any one with room', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored', extra: [{ id: 'b', token: 'oauth-b' }] });
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 }, 'login');
  assert.deepEqual([billing.betterAccountAvailable('b'), billing.betterAccountAvailable('api'), billing.accountBlocked('login')], [false, true, true]);
  advance(HOUR);
  assert.deepEqual([billing.betterAccountAvailable('b'), billing.accountBlocked('login'), billing.accountBlocked('api')], [true, false, false]);
});

test("an extra account's own full bar counts as its limit", () => {
  const { billing } = createBilling({ order: ['b', 'login'], extra: [{ id: 'b', token: 'oauth-b', limits: [{ kind: 'weekly_all', percent: 100, resetsAt: NOW + HOUR }] }] });
  assert.equal((billing.resolve() as { account: { id: string } }).account.id, 'login');
  assert.deepEqual(billing.getStatus().accounts.map((account) => [account.id, account.limit?.kind ?? null]), [['b', 'weekly_all'], ['login', null]]);
});
