import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeListPrices } from '../claude-list-prices.service.js';

const NOW = Date.parse('2026-11-11T14:00:00Z');
const STANDARD = { model: 'claude-opus-5-5', context_window: '0-200k', service_tier: 'standard', speed: 'standard' };

const LIST = {
  'claude-opus-5-5': {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
    cache_creation_input_token_cost_above_1hr: 8e-6,
    input_cost_per_token_batches: 2e-6,
    output_cost_per_token_above_200k_tokens: 3e-5,
    search_context_cost_per_query: { search_context_size_medium: 0.01 },
  },
};

function createPrices(responses: (() => Response)[]) {
  let clock = NOW;
  let calls = 0;
  const prices = createClaudeListPrices({
    fetch: (async () => responses[Math.min(calls++, responses.length - 1)]()) as typeof fetch,
    now: () => clock,
  });
  return { prices, calls: () => calls, advance: (ms: number) => { clock += ms; } };
}

test('every report unit maps to its list field, in cents', async () => {
  const lookup = await createPrices([() => new Response(JSON.stringify(LIST))]).prices.load();
  const cents = (unit: string, dimensions = STANDARD) => lookup(dimensions, unit)?.toPrecision(3);
  assert.deepEqual(
    ['uncached_input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation.ephemeral_5m_input_tokens', 'cache_creation.ephemeral_1h_input_tokens', 'web_search'].map((unit) => cents(unit)),
    ['0.000400', '0.00200', '0.0000200', '0.000500', '0.000800', '1.00'],
  );
  assert.equal(cents('output_tokens', { ...STANDARD, context_window: '200k-1M' }), '0.00300');
  assert.equal(cents('uncached_input_tokens', { ...STANDARD, context_window: '200k-1M' }), '0.000400');
  assert.equal(cents('uncached_input_tokens', { ...STANDARD, service_tier: 'batch' }), '0.000200');
  assert.equal(cents('output_tokens', { ...STANDARD, service_tier: 'batch' }), undefined);
  assert.equal(cents('output_tokens', { ...STANDARD, speed: 'fast' }), undefined);
  assert.equal(cents('output_tokens', { ...STANDARD, model: 'claude-unknown' }), undefined);
});

test('the list is fetched once a day, and a failed fetch keeps the previous list and waits an hour', async () => {
  const { prices, calls, advance } = createPrices([() => new Response(JSON.stringify(LIST)), () => new Response('', { status: 503 })]);
  await prices.load();
  await prices.load();
  assert.equal(calls(), 1);
  advance(86_400_000);
  const lookup = await prices.load();
  assert.equal(calls(), 2);
  assert.notEqual(lookup(STANDARD, 'output_tokens'), undefined);
  advance(30 * 60_000);
  await prices.load();
  assert.equal(calls(), 2);
  advance(30 * 60_000);
  await prices.load();
  assert.equal(calls(), 3);
});
