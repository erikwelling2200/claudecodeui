/** The dimensions a usage row is priced by, named as in Anthropic's usage and cost reports. */
export type PriceDimensions = { model: string | null; context_window: string | null; service_tier: string | null; speed: string | null };

/** A per-unit price in cents, or `undefined` when the list has none for that model, tier or unit. */
export type ListPriceLookup = (dimensions: PriceDimensions, unit: string) => number | undefined;

type ListPricesDependencies = {
  fetch: typeof fetch;
  now?: () => number;
};

// LiteLLM's community-maintained price list: Anthropic's public list prices, in USD per token, keyed by model id.
const PRICE_LIST_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_MS = 86_400_000;
const RETRY_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 20_000;

// The list's field per report unit; the long-context and batch variants are found by suffix.
const UNIT_FIELDS: Record<string, string> = {
  uncached_input_tokens: 'input_cost_per_token',
  output_tokens: 'output_cost_per_token',
  cache_read_input_tokens: 'cache_read_input_token_cost',
  'cache_creation.ephemeral_5m_input_tokens': 'cache_creation_input_token_cost',
  'cache_creation.ephemeral_1h_input_tokens': 'cache_creation_input_token_cost_above_1hr',
};

/**
 * Public list prices for the models the organization's own bills cannot price yet, such as one it never used before.
 * The list is fetched at most once a day; while it cannot be fetched, nothing is priced from it.
 */
export function createClaudeListPrices(dependencies: ListPricesDependencies) {
  const now = dependencies.now ?? Date.now;
  let prices: Record<string, Record<string, any>> | null = null;
  let fetchedAt = 0;
  let attemptedAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    attemptedAt = now();
    try {
      const response = await dependencies.fetch(PRICE_LIST_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Price list returned ${response.status}`);
      prices = await response.json() as Record<string, Record<string, any>>;
      fetchedAt = now();
    } catch {
      // A stale list prices better than none, so the previous one is kept.
    }
  }

  function lookup(dimensions: PriceDimensions, unit: string): number | undefined {
    const entry = dimensions.model ? prices?.[dimensions.model] ?? prices?.[`anthropic/${dimensions.model}`] : undefined;
    if (!entry || (dimensions.speed ?? 'standard') !== 'standard') return undefined;
    const tier = dimensions.service_tier ?? 'standard';
    if (tier !== 'standard' && tier !== 'batch') return undefined;
    if (unit === 'web_search') {
      const perQuery = entry.search_context_cost_per_query?.search_context_size_medium;
      return typeof perQuery === 'number' ? perQuery * 100 : undefined;
    }
    const field = UNIT_FIELDS[unit];
    if (!field) return undefined;
    const longContext = dimensions.context_window === '200k-1M' ? entry[`${field}_above_200k_tokens`] : undefined;
    const usd = tier === 'batch' ? entry[`${field}_batches`] : longContext ?? entry[field];
    return typeof usd === 'number' ? usd * 100 : undefined;
  }

  /** The lookup over the current list, refreshing it first when it is a day old. */
  async function load(): Promise<ListPriceLookup> {
    const due = now() - fetchedAt >= REFRESH_MS && now() - attemptedAt >= RETRY_MS;
    if (due && !inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    if (inFlight) await inFlight;
    return lookup;
  }

  return { load };
}
