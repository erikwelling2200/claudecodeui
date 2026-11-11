import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeCreditService, creditCycleStart } from '../claude-credit.service.js';

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

type Page = { data: { starting_at: string; results: { amount: string }[] }[]; has_more: boolean; next_page: string | null };

function createCredit(pages: Page[] | { status: number; message: string }, settings: Record<string, string> = {}) {
  const config = new Map(Object.entries({ claude_cost_report_key: 'sk-org-key', claude_credit_renewal_day: '20', ...settings }));
  const requests: URL[] = [];
  let clock = NOW;
  const fakeFetch = (async (input: URL) => {
    requests.push(input);
    if (!Array.isArray(pages)) return new Response(JSON.stringify({ error: { message: pages.message } }), { status: pages.status });
    const page = pages[input.searchParams.get('page') ? Number(input.searchParams.get('page')) : 0];
    return new Response(JSON.stringify(page));
  }) as typeof fetch;
  const credit = createClaudeCreditService({
    config: { get: (key) => config.get(key) ?? null, set: (key, value) => { config.set(key, value); } },
    fetch: fakeFetch,
    now: () => clock,
  });
  return { credit, requests, advance: (ms: number) => { clock += ms; } };
}

test('sums every page of the cost report since the cycle start, with today on its own', async () => {
  const { credit, requests } = createCredit([
    { data: [{ starting_at: '2026-10-30T00:00:00Z', results: [{ amount: '1000.5' }, { amount: '22.5476' }] }], has_more: true, next_page: '1' },
    { data: [{ starting_at: '2026-11-11T00:00:00Z', results: [{ amount: '250' }] }], has_more: false, next_page: null },
  ]);
  const status = await credit.getStatus();
  assert.deepEqual({ today: status.org?.today, cycle: status.org?.cycle }, { today: 2.5, cycle: 12.730476 });
  assert.equal(status.keyHint, '-key');
  assert.equal(requests[0].searchParams.get('starting_at'), '2026-10-20T00:00:00Z');
  assert.equal(requests[0].searchParams.get('ending_at'), '2026-11-12T00:00:00Z');
});

test('a reading is reused for a minute before the report is asked again', async () => {
  const { credit, requests, advance } = createCredit([{ data: [], has_more: false, next_page: null }]);
  await credit.getStatus();
  await credit.getStatus();
  assert.equal(requests.length, 1);
  advance(61_000);
  await credit.getStatus();
  assert.equal(requests.length, 2);
});

test('a refused key reports the API error and no organization total', async () => {
  const { credit } = createCredit({ status: 403, message: 'permission denied' });
  const status = await credit.getStatus();
  assert.equal(status.org, null);
  assert.equal(status.error, 'Cost report returned 403: permission denied');
});

test('without a key nothing is fetched', async () => {
  const { credit, requests } = createCredit([], { claude_cost_report_key: '' });
  const status = await credit.getStatus();
  assert.equal(requests.length, 0);
  assert.deepEqual({ org: status.org, error: status.error, keyHint: status.keyHint }, { org: null, error: null, keyHint: null });
});

test('changing the renewal day refetches from the new cycle start', async () => {
  const { credit, requests } = createCredit([{ data: [], has_more: false, next_page: null }]);
  await credit.getStatus();
  const status = await credit.setCycle({ renewalDay: 1, amount: 180 });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get('starting_at'), '2026-11-01T00:00:00Z');
  assert.equal(status.amount, 180);
});
