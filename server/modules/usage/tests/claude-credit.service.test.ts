import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeCreditService, creditCycleStart } from '../claude-credit.service.js';
import type { UsageResult } from '../claude-credit.service.js';
import type { ListPriceLookup } from '../claude-list-prices.service.js';

const NOW = Date.parse('2026-11-11T14:00:00Z');

test('the cycle starts on the most recent renewal day at 00:00 UTC', () => {
  assert.equal(creditCycleStart(NOW, 20), Date.parse('2026-10-20T00:00:00Z'));
  assert.equal(creditCycleStart(NOW, 11), Date.parse('2026-11-11T00:00:00Z'));
  assert.equal(creditCycleStart(NOW, 1), Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(creditCycleStart(Date.parse('2026-01-05T00:00:00Z'), 20), Date.parse('2025-12-20T00:00:00Z'));
});

test('a renewal day past the end of a month falls on its last day', () => {
  assert.equal(creditCycleStart(Date.parse('2026-03-10T00:00:00Z'), 31), Date.parse('2026-02-28T00:00:00Z'));
});

type Report = { data: unknown[]; has_more: boolean; next_page: string | null };
type Reports = { cost: Report[]; days?: Report[]; today?: Report[] };

const EMPTY: Report = { data: [], has_more: false, next_page: null };
const DIMENSIONS = { model: 'claude-fable-5-2', context_window: '0-200k', service_tier: 'standard', speed: 'standard' };

function usageRow(tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite1h?: number; searches?: number }, dimensions = DIMENSIONS) {
  return {
    ...dimensions,
    uncached_input_tokens: tokens.input ?? 0,
    output_tokens: tokens.output ?? 0,
    cache_read_input_tokens: tokens.cacheRead ?? 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: tokens.cacheWrite1h ?? 0 },
    server_tool_use: { web_search_requests: tokens.searches ?? 0 },
  };
}

function costRow(amount: string, tokenType: string | null, dimensions = DIMENSIONS) {
  return { ...dimensions, amount, cost_type: tokenType ? 'tokens' : 'web_search', token_type: tokenType };
}

type Local = { listPrice?: ListPriceLookup; recent?: UsageResult[] };

function createCredit(reports: Reports | { status: number; message: string }, settings: Record<string, string> = {}, local: Local = {}) {
  const config = new Map(Object.entries({ claude_cost_report_key: 'sk-org-key', claude_credit_renewal_day: '20', ...settings }));
  const requests: URL[] = [];
  const recentSince: number[] = [];
  let clock = NOW;
  const fakeFetch = (async (input: URL) => {
    requests.push(input);
    if (!('cost' in reports)) return new Response(JSON.stringify({ error: { message: reports.message } }), { status: reports.status });
    const pages = input.pathname.endsWith('/cost_report') ? reports.cost
      : input.searchParams.get('bucket_width') === '1m' ? reports.today ?? [EMPTY] : reports.days ?? [EMPTY];
    return new Response(JSON.stringify(pages[input.searchParams.get('page') ? Number(input.searchParams.get('page')) : 0]));
  }) as typeof fetch;
  const credit = createClaudeCreditService({
    config: { get: (key) => config.get(key) ?? null, set: (key, value) => { config.set(key, value); } },
    fetch: fakeFetch,
    listPrices: { load: async () => local.listPrice ?? (() => undefined) },
    recentUsage: (since) => { recentSince.push(since); return local.recent ?? []; },
    now: () => clock,
  });
  return { credit, requests, recentSince, advance: (ms: number) => { clock += ms; } };
}

const costRequests = (requests: URL[]) => requests.filter((url) => url.pathname.endsWith('/cost_report'));

test('the cycle sums every page of the cost report from the cycle start, which never includes today', async () => {
  const { credit, requests } = createCredit({
    cost: [
      { data: [{ starting_at: '2026-10-12T00:00:00Z', results: [costRow('9999', 'output_tokens')] }], has_more: true, next_page: '1' },
      { data: [{ starting_at: '2026-10-30T00:00:00Z', results: [costRow('1000.5', 'output_tokens'), costRow('22.5476', 'uncached_input_tokens')] }], has_more: false, next_page: null },
    ],
  });
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today, cycle: status.org?.cycle }, { today: 0, cycle: 10.230476 });
  assert.equal(status.keyHint, '-key');
  const [first] = costRequests(requests);
  assert.equal(first.searchParams.get('starting_at'), '2026-10-11T00:00:00Z');
  assert.equal(first.searchParams.get('ending_at'), '2026-11-11T00:00:00Z');
  assert.equal(first.searchParams.get('group_by[]'), 'description');
});

test('today is the usage so far, priced at what the cost report charged per unit on earlier days', async () => {
  const { credit, requests } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [costRow('400', 'output_tokens'), costRow('30', 'cache_read_input_tokens'), costRow('2', null)] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [usageRow({ output: 100_000, cacheRead: 1_000_000, searches: 2 })] }], has_more: false, next_page: null }],
    today: [{ data: [
      { starting_at: '2026-11-11T09:00:00Z', results: [usageRow({ output: 50_000, cacheRead: 200_000 })] },
      { starting_at: '2026-11-11T13:29:00Z', results: [usageRow({ searches: 1 })] },
    ], has_more: false, next_page: null }],
  });
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today, cycle: status.org?.cycle, unpriced: status.org?.todayUnpriced }, { today: 2.07, cycle: 6.39, unpriced: false });
  const today = requests.find((url) => url.searchParams.get('bucket_width') === '1m')!;
  assert.equal(today.searchParams.get('starting_at'), '2026-11-11T00:00:00Z');
  assert.equal(today.searchParams.get('ending_at'), '2026-11-11T14:00:00Z');
  assert.deepEqual(today.searchParams.getAll('group_by[]'), ['model', 'context_window', 'service_tier', 'speed']);
});

test("a rate not billed before is priced from the model's other rates, at the ratios other models show", async () => {
  const opus = { ...DIMENSIONS, model: 'claude-opus-5-5' };
  const { credit } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [
      costRow('400', 'uncached_input_tokens', opus), costRow('800', 'cache_creation.ephemeral_1h_input_tokens', opus), costRow('2000', 'output_tokens', opus),
      costRow('4000', 'output_tokens'),
    ] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [
      usageRow({ input: 1_000_000, cacheWrite1h: 1_000_000, output: 1_000_000 }, opus),
      usageRow({ output: 1_000_000 }),
    ] }], has_more: false, next_page: null }],
    today: [{ data: [{ starting_at: '2026-11-11T09:00:00Z', results: [
      // Fable output in the other context window: its own $40/MTok, so $4.
      usageRow({ output: 100_000 }, { ...DIMENSIONS, context_window: '200k-1M' }),
      // Fable 1h writes: input $40 / 5 = $8, times Opus's 2x write ratio = $16/MTok, so $1.60.
      usageRow({ cacheWrite1h: 100_000 }),
    ] }], has_more: false, next_page: null }],
  });
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today.toFixed(2), unpriced: status.org?.todayUnpriced }, { today: '5.60', unpriced: false });
});

test('a model never billed before is left out of today and flagged', async () => {
  const { credit } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [costRow('400', 'output_tokens')] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [usageRow({ output: 100_000 })] }], has_more: false, next_page: null }],
    today: [{ data: [{ starting_at: '2026-11-11T09:00:00Z', results: [
      usageRow({ output: 1000 }),
      usageRow({ output: 1000 }, { ...DIMENSIONS, model: 'claude-new-6' }),
    ] }], has_more: false, next_page: null }],
  });
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today, unpriced: status.org?.todayUnpriced }, { today: 0.04, unpriced: true });
});

test('a model never billed before is priced at its public list price', async () => {
  const listPrice: ListPriceLookup = (dimensions, unit) => (dimensions.model === 'claude-new-6' && unit === 'output_tokens' ? 0.005 : undefined);
  const { credit } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [costRow('400', 'output_tokens')] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [usageRow({ output: 100_000 })] }], has_more: false, next_page: null }],
    today: [{ data: [{ starting_at: '2026-11-11T09:00:00Z', results: [
      usageRow({ output: 1000 }),
      usageRow({ output: 1000 }, { ...DIMENSIONS, model: 'claude-new-6' }),
    ] }], has_more: false, next_page: null }],
  }, {}, { listPrice });
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today, unpriced: status.org?.todayUnpriced }, { today: 0.09, unpriced: false });
});

test("a learned price wins over the list price, the list price over another unit's ratio", async () => {
  const listPrice: ListPriceLookup = (_dimensions, unit) => ({ output_tokens: 1, 'cache_creation.ephemeral_1h_input_tokens': 0.003 } as Record<string, number>)[unit];
  const opus = { ...DIMENSIONS, model: 'claude-opus-5-5' };
  const { credit } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [
      costRow('400', 'output_tokens'), costRow('100', 'uncached_input_tokens'),
      costRow('100', 'uncached_input_tokens', opus), costRow('200', 'cache_creation.ephemeral_1h_input_tokens', opus),
    ] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [
      usageRow({ output: 100_000, input: 100_000 }),
      usageRow({ input: 1_000_000, cacheWrite1h: 1_000_000 }, opus),
    ] }], has_more: false, next_page: null }],
    today: [{ data: [{ starting_at: '2026-11-11T09:00:00Z', results: [usageRow({ output: 1000, cacheWrite1h: 1000 })] }], has_more: false, next_page: null }],
  }, {}, { listPrice });
  const status = await credit.getStatus();
  // Output at the learned 0.004 cents a token; 1h writes at the listed 0.003, not Opus's 2x ratio to input (0.002).
  assert.equal(status.org?.today, 0.07);
});

test("the report's last half hour is left to this app's own usage, which it lags behind", async () => {
  const { credit, recentSince } = createCredit({
    cost: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [costRow('400', 'output_tokens')] }], has_more: false, next_page: null }],
    days: [{ data: [{ starting_at: '2026-11-10T00:00:00Z', results: [usageRow({ output: 100_000 })] }], has_more: false, next_page: null }],
    today: [{ data: [
      { starting_at: '2026-11-11T13:29:00Z', results: [usageRow({ output: 1000 })] },
      { starting_at: '2026-11-11T13:30:00Z', results: [usageRow({ output: 50_000 })] },
    ], has_more: false, next_page: null }],
  }, {}, { recent: [usageRow({ output: 2000 })] });
  const status = await credit.getStatus();
  assert.deepEqual(recentSince, [Date.parse('2026-11-11T13:30:00Z')]);
  assert.equal(status.org?.today, 0.12);
});

test('a reading is reused for a minute before the reports are asked again', async () => {
  const { credit, requests, advance } = createCredit({ cost: [EMPTY] });
  await credit.getStatus();
  await credit.getStatus();
  assert.equal(costRequests(requests).length, 1);
  advance(61_000);
  await credit.getStatus();
  assert.equal(costRequests(requests).length, 2);
});

test('a refused key reports the API error and no organization total', async () => {
  const { credit } = createCredit({ status: 403, message: 'permission denied' });
  const status = await credit.getStatus();
  assert.equal(status.org, null);
  assert.match(status.error ?? '', /^(Cost|Usage) report returned 403: permission denied$/);
});

test('without a key nothing is fetched', async () => {
  const { credit, requests } = createCredit({ cost: [] }, { claude_cost_report_key: '' });
  const status = await credit.getStatus();
  assert.equal(requests.length, 0);
  assert.deepEqual({ org: status.org, error: status.error, keyHint: status.keyHint }, { org: null, error: null, keyHint: null });
});

test('changing the renewal day refetches, still learning prices from 31 days back', async () => {
  const { credit, requests } = createCredit({ cost: [EMPTY] });
  await credit.getStatus();
  const status = await credit.setCycle({ renewalDay: 1, amount: 180 });
  assert.equal(costRequests(requests).length, 2);
  assert.equal(costRequests(requests)[1].searchParams.get('starting_at'), '2026-10-11T00:00:00Z');
  assert.equal(status.amount, 180);
});
