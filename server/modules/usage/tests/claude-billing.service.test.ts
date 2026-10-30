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
};

function createBilling(options: Options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  if (options.loggedIn !== false) {
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  }
  const config = new Map<string, string>(options.storedKey ? [['claude_fallback_api_key', options.storedKey]] : []);
  const ledger: { costUsd: number; at: number }[] = [];
  let clock = NOW;
  const billing = createClaudeBillingService({
    homeDirectory: home,
    hostEnv: options.hostEnv ?? {},
    config: { get: (key) => config.get(key) ?? null, set: (key, value) => { config.set(key, value); } },
    spend: {
      record: (costUsd, _sessionId, at) => { ledger.push({ costUsd, at }); },
      sumSince: (since) => ledger.filter((row) => row.at >= since).reduce((sum, row) => sum + row.costUsd, 0),
    },
    readUsageLimits: () => options.limits ?? [],
    now: () => clock,
  });
  return { billing, advance: (ms: number) => { clock += ms; } };
}

test('the subscription is used while it has room, even with a key stored', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored' });
  assert.deepEqual(billing.resolve(), { mode: 'subscription' });
});

test('a rejected session limit moves runs to the stored key until it resets', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored' });
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 });
  assert.deepEqual(billing.resolve(), { mode: 'api_key', variable: 'ANTHROPIC_API_KEY', key: 'sk-stored', limit: { kind: 'five_hour', resetsAt: NOW + HOUR } });
  advance(HOUR);
  assert.deepEqual(billing.resolve(), { mode: 'subscription' });
});

test('a full session bar moves runs to the key before any run has been rejected', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'session', percent: 100, resetsAt: NOW + HOUR }] });
  assert.equal(billing.resolve().mode, 'api_key');
});

test('a full model-scoped weekly bar does not, since other models still run on the plan', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored', limits: [{ kind: 'weekly_opus', percent: 100, resetsAt: NOW + HOUR }] });
  assert.equal(billing.resolve().mode, 'subscription');
});

test('warnings and overage events do not count as a limit hit', () => {
  const { billing } = createBilling({ storedKey: 'sk-stored' });
  billing.noteRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: (NOW + HOUR) / 1000 });
  billing.noteRateLimit({ status: 'rejected', rateLimitType: 'overage', resetsAt: (NOW + HOUR) / 1000 });
  assert.equal(billing.resolve().mode, 'subscription');
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
  assert.deepEqual(createBilling({ hostEnv, limits }).billing.resolve(), { mode: 'api_key', variable: 'ANTHROPIC_AUTH_TOKEN', key: 'env-token', limit: { kind: 'session', resetsAt: NOW + HOUR } });
  assert.equal((createBilling({ hostEnv, limits, storedKey: 'sk-stored' }).billing.resolve() as { key: string }).key, 'sk-stored');
});

test('with no subscription login a key is used outright, and with neither the env is left alone', () => {
  assert.equal(createBilling({ loggedIn: false, storedKey: 'sk-stored' }).billing.resolve().mode, 'api_key');
  assert.deepEqual(createBilling({ loggedIn: false }).billing.resolve(), { mode: 'none' });
});

test('the env for a subscription run carries no key; for a key run only the chosen one', () => {
  const env = { PATH: 'x', ANTHROPIC_API_KEY: 'env-key', ANTHROPIC_AUTH_TOKEN: 'env-token' };
  assert.deepEqual(applyClaudeBillingEnv(env, { mode: 'subscription' }), { PATH: 'x' });
  assert.deepEqual(applyClaudeBillingEnv(env, { mode: 'api_key', variable: 'ANTHROPIC_API_KEY', key: 'sk-stored', limit: null }), { PATH: 'x', ANTHROPIC_API_KEY: 'sk-stored' });
  assert.equal(applyClaudeBillingEnv(env, { mode: 'none' }), env);
});

test('spend is totalled for today and for the month', () => {
  const { billing, advance } = createBilling({ storedKey: 'sk-stored' });
  billing.recordSpend(1.25, 's1');
  billing.recordSpend(0, 's1');
  advance(-3 * 24 * HOUR);
  billing.recordSpend(2, 's2');
  advance(3 * 24 * HOUR);
  assert.deepEqual(billing.getStatus().spend, { today: 1.25, month: 3.25 });
  assert.equal(billing.getStatus().keyHint, 'ored');
  assert.equal(billing.getStatus().keySource, 'settings');
});
