import type { ListPriceLookup, PriceDimensions } from './claude-list-prices.service.js';

type CreditConfig = { get(key: string): string | null; set(key: string, value: string): void };

type ClaudeCreditDependencies = {
  config: CreditConfig;
  fetch: typeof fetch;
  /** Public list prices, for usage the organization's own bills cannot price. */
  listPrices: { load(): Promise<ListPriceLookup> };
  /** This app's own API-key usage recorded at or after `since`, for the minutes the usage report has not caught up with. */
  recentUsage: (since: number) => UsageResult[];
  now?: () => number;
};

/** The organization's API spend over the current credit cycle, as `/api/usage` reports it; amounts are USD, times epoch milliseconds. */
export type ClaudeCreditStatus = {
  keyHint: string | null;
  renewalDay: number;
  amount: number | null;
  cycleStart: number;
  /** `todayUnpriced`: today used a model or rate the previous days never billed, so `today` leaves that part out. */
  org: { today: number; cycle: number; todayUnpriced: boolean; fetchedAt: number } | null;
  error: string | null;
};

const KEY = 'claude_cost_report_key';
const RENEWAL_DAY = 'claude_credit_renewal_day';
const AMOUNT = 'claude_credit_amount';
const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const USAGE_REPORT_URL = 'https://api.anthropic.com/v1/organizations/usage_report/messages';
const API_VERSION = '2026-10-21';
// The reports lag a few minutes, so polling them faster than this shows nothing new.
const REFRESH_MS = 60_000;
// The usage report runs about half an hour behind, so today's most recent minutes come from this app's own usage instead.
const REPORT_LAG_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
// How many finished days the per-unit prices are learned from, at least; the whole cycle when it is longer.
const PRICE_HISTORY_DAYS = 31;

// The dimensions a price depends on, named the same in both reports.
const USAGE_GROUPS = ['model', 'context_window', 'service_tier', 'speed'];
type CostBucket = { starting_at: string; results: (PriceDimensions & { amount: string; cost_type: string | null; token_type: string | null })[] };
export type UsageResult = PriceDimensions & {
  uncached_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  server_tool_use: { web_search_requests: number };
};
type UsageBucket = { starting_at: string; results: UsageResult[] };

function priceKey(dimensions: PriceDimensions, unit: string): string {
  return [dimensions.model, dimensions.context_window, dimensions.service_tier, dimensions.speed, unit].join('|');
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Prices a unit from learned per-unit prices (keyed by `priceKey`), most specific first: the exact rate; the same
 * model's rate in another context window; the public list price; or the model's input price times that unit's usual
 * ratio to input, the median over the models that have both.
 */
function createPriceLookup(prices: Map<string, number>, listPrice: ListPriceLookup): (dimensions: PriceDimensions, unit: string) => number | undefined {
  const modelKey = (model: string | null, tier: string | null, speed: string | null) => [model, tier, speed].join('|');
  const byModel = new Map<string, Map<string, number[]>>();
  for (const [key, price] of prices) {
    const [model, , tier, speed, unit] = key.split('|');
    const units = byModel.get(modelKey(model, tier, speed)) ?? new Map<string, number[]>();
    units.set(unit, [...(units.get(unit) ?? []), price]);
    byModel.set(modelKey(model, tier, speed), units);
  }
  const modelPrice = new Map<string, Map<string, number>>();
  for (const [model, units] of byModel) modelPrice.set(model, new Map([...units].map(([unit, list]) => [unit, median(list)!])));

  const ratioSamples = new Map<string, number[]>();
  for (const units of modelPrice.values()) {
    const input = units.get('uncached_input_tokens');
    if (!input) continue;
    for (const [unit, price] of units) ratioSamples.set(unit, [...(ratioSamples.get(unit) ?? []), price / input]);
  }
  const ratios = new Map([...ratioSamples].map(([unit, samples]) => [unit, median(samples)!]));

  return (dimensions, unit) => {
    const exact = prices.get(priceKey(dimensions, unit));
    if (exact !== undefined) return exact;
    const units = modelPrice.get(modelKey(dimensions.model, dimensions.service_tier, dimensions.speed));
    const sameModel = units?.get(unit);
    if (sameModel !== undefined) return sameModel;
    const listed = listPrice(dimensions, unit);
    if (listed !== undefined || !units) return listed;
    const ratio = ratios.get(unit);
    if (ratio === undefined) return undefined;
    const input = units.get('uncached_input_tokens')
      ?? [...units].map(([known, price]) => (ratios.get(known) ? price / ratios.get(known)! : undefined)).find((value) => value !== undefined);
    return input === undefined ? undefined : input * ratio;
  };
}

/** A usage row's billable amounts, keyed by the cost report's `token_type` (or `web_search`) they are charged under. */
function usageUnits(result: UsageResult): [string, number][] {
  const units: [string, number][] = [
    ['uncached_input_tokens', result.uncached_input_tokens],
    ['cache_read_input_tokens', result.cache_read_input_tokens],
    ['output_tokens', result.output_tokens],
    ['cache_creation.ephemeral_5m_input_tokens', result.cache_creation?.ephemeral_5m_input_tokens ?? 0],
    ['cache_creation.ephemeral_1h_input_tokens', result.cache_creation?.ephemeral_1h_input_tokens ?? 0],
    ['web_search', result.server_tool_use?.web_search_requests ?? 0],
  ];
  return units.filter(([, amount]) => amount > 0);
}

/** The most recent 00:00 UTC on `renewalDay` at or before `now`; a day past the month's end means its last day. */
export function creditCycleStart(now: number, renewalDay: number): number {
  const date = new Date(now);
  const startIn = (year: number, month: number) => Date.UTC(year, month, Math.min(renewalDay, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
  const start = startIn(date.getUTCFullYear(), date.getUTCMonth());
  return start <= now ? start : startIn(date.getUTCFullYear(), date.getUTCMonth() - 1);
}

function isoSeconds(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Reads what the whole Console organization spent this credit cycle from Anthropic's cost and usage reports, so the sidebar
 * also counts usage outside this app. The report needs an organization-scoped service-account (or Admin) key.
 */
export function createClaudeCreditService(dependencies: ClaudeCreditDependencies) {
  const now = dependencies.now ?? Date.now;
  const { config } = dependencies;
  let cache: { key: string; cycleStart: number; today: number; cycle: number; todayUnpriced: boolean; fetchedAt: number } | null = null;
  let lastAttemptAt = 0;
  let lastError: string | null = null;
  let inFlight: Promise<void> | null = null;

  function key(): string | null {
    return config.get(KEY)?.trim() || null;
  }

  function renewalDay(): number {
    const day = Number(config.get(RENEWAL_DAY));
    return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
  }

  function amount(): number | null {
    const value = Number(config.get(AMOUNT));
    return config.get(AMOUNT) && Number.isFinite(value) && value > 0 ? value : null;
  }

  function cycleStart(): number {
    return creditCycleStart(now(), renewalDay());
  }

  async function fetchPages<T>(apiKey: string, endpoint: string, params: Record<string, string | string[]>): Promise<T[]> {
    const buckets: T[] = [];
    let page: string | null = null;
    do {
      const url = new URL(endpoint);
      for (const [name, value] of Object.entries(params)) for (const item of [value].flat()) url.searchParams.append(name, item);
      if (page) url.searchParams.set('page', page);
      const response = await dependencies.fetch(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        const report = endpoint === COST_REPORT_URL ? 'Cost report' : 'Usage report';
        throw new Error(`${report} returned ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
      }
      const body = await response.json() as { data: T[]; has_more: boolean; next_page: string | null };
      buckets.push(...body.data);
      page = body.has_more ? body.next_page : null;
    } while (page);
    return buckets;
  }

  /**
   * Finished days come from the cost report, which never returns the day in progress. Today is the token report's
   * per-minute usage priced at what the cost report charged per unit over the previous days, up to half an hour ago;
   * after that, this app's own usage at the same prices.
   */
  async function fetchSpend(apiKey: string, since: number): Promise<{ today: number; cycle: number; todayUnpriced: boolean }> {
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    const historyStart = Math.min(since, todayStart - PRICE_HISTORY_DAYS * DAY_MS);
    const reportEnd = Math.max(todayStart, Math.floor((now() - REPORT_LAG_MS) / 60_000) * 60_000);
    const [listPrice, costBuckets, usageBuckets, todayBuckets] = await Promise.all([
      dependencies.listPrices.load(),
      fetchPages<CostBucket>(apiKey, COST_REPORT_URL, { starting_at: isoSeconds(historyStart), ending_at: isoSeconds(todayStart), limit: '31', 'group_by[]': 'description' }),
      fetchPages<UsageBucket>(apiKey, USAGE_REPORT_URL, { starting_at: isoSeconds(historyStart), ending_at: isoSeconds(todayStart), bucket_width: '1d', limit: '31', 'group_by[]': USAGE_GROUPS }),
      fetchPages<UsageBucket>(apiKey, USAGE_REPORT_URL, { starting_at: isoSeconds(todayStart), ending_at: isoSeconds(now()), bucket_width: '1m', limit: '1440', 'group_by[]': USAGE_GROUPS }),
    ]);

    const charged = new Map<string, { cents: number; units: number }>();
    let cycleCents = 0;
    for (const bucket of costBuckets) {
      for (const result of bucket.results) {
        const cents = Number(result.amount);
        if (Date.parse(bucket.starting_at) >= since) cycleCents += cents;
        const unit = result.cost_type === 'web_search' ? 'web_search' : result.cost_type === 'tokens' ? result.token_type : null;
        if (!unit || !result.model) continue;
        const entry = charged.get(priceKey(result, unit)) ?? { cents: 0, units: 0 };
        entry.cents += cents;
        charged.set(priceKey(result, unit), entry);
      }
    }
    for (const bucket of usageBuckets) {
      for (const result of bucket.results) {
        for (const [unit, units] of usageUnits(result)) {
          const entry = charged.get(priceKey(result, unit));
          if (entry) entry.units += units;
        }
      }
    }
    const prices = new Map<string, number>();
    for (const [key, { cents, units }] of charged) if (units > 0) prices.set(key, cents / units);
    const priceOf = createPriceLookup(prices, listPrice);

    const todayResults = [
      ...todayBuckets.filter((bucket) => Date.parse(bucket.starting_at) < reportEnd).flatMap((bucket) => bucket.results),
      ...dependencies.recentUsage(reportEnd),
    ];
    let todayCents = 0;
    let todayUnpriced = false;
    for (const result of todayResults) {
      for (const [unit, units] of usageUnits(result)) {
        const price = priceOf(result, unit);
        if (price === undefined) todayUnpriced = true;
        else todayCents += units * price;
      }
    }
    return { today: todayCents / 100, cycle: (cycleCents + todayCents) / 100, todayUnpriced };
  }

  /** Refetches when the cached reading is older than a minute, or was for another key or cycle. */
  async function refresh(force = false): Promise<void> {
    const apiKey = key();
    if (!apiKey) return;
    const since = cycleStart();
    const fresh = cache && cache.key === apiKey && cache.cycleStart === since && now() - cache.fetchedAt < REFRESH_MS;
    if (!force && (fresh || now() - lastAttemptAt < REFRESH_MS)) return;
    if (inFlight) {
      // A forced refresh follows a settings change, which the request already running did not see.
      await inFlight;
      if (!force) return;
      return refresh(true);
    }
    lastAttemptAt = now();
    inFlight = (async () => {
      try {
        const spend = await fetchSpend(apiKey, since);
        cache = { key: apiKey, cycleStart: since, ...spend, fetchedAt: now() };
        lastError = null;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function snapshot(): ClaudeCreditStatus {
    const apiKey = key();
    const since = cycleStart();
    const reading = cache && cache.key === apiKey && cache.cycleStart === since ? cache : null;
    return {
      keyHint: apiKey ? apiKey.slice(-4) : null,
      renewalDay: renewalDay(),
      amount: amount(),
      cycleStart: since,
      org: reading ? { today: reading.today, cycle: reading.cycle, todayUnpriced: reading.todayUnpriced, fetchedAt: reading.fetchedAt } : null,
      error: apiKey ? lastError : null,
    };
  }

  async function getStatus(): Promise<ClaudeCreditStatus> {
    await refresh();
    return snapshot();
  }

  async function setKey(value: string): Promise<ClaudeCreditStatus> {
    config.set(KEY, value.trim());
    lastError = null;
    await refresh(true);
    return snapshot();
  }

  function clearKey(): ClaudeCreditStatus {
    config.set(KEY, '');
    cache = null;
    lastError = null;
    return snapshot();
  }

  async function setCycle(settings: { renewalDay: number; amount: number | null }): Promise<ClaudeCreditStatus> {
    config.set(RENEWAL_DAY, String(settings.renewalDay));
    config.set(AMOUNT, settings.amount === null ? '' : String(settings.amount));
    await refresh(true);
    return snapshot();
  }

  return { cycleStart, getStatus, setKey, clearKey, setCycle };
}
