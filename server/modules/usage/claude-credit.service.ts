type CreditConfig = { get(key: string): string | null; set(key: string, value: string): void };

type ClaudeCreditDependencies = {
  config: CreditConfig;
  fetch: typeof fetch;
  now?: () => number;
};

/** The organization's API spend over the current credit cycle, as `/api/usage` reports it; amounts are USD, times epoch milliseconds. */
export type ClaudeCreditStatus = {
  keyHint: string | null;
  renewalDay: number;
  amount: number | null;
  cycleStart: number;
  org: { today: number; cycle: number; fetchedAt: number } | null;
  error: string | null;
};

const KEY = 'claude_cost_report_key';
const RENEWAL_DAY = 'claude_credit_renewal_day';
const AMOUNT = 'claude_credit_amount';
const COST_REPORT_URL = 'https://api.anthropic.com/v1/organizations/cost_report';
const API_VERSION = '2026-10-21';
// The cost report itself lags a few minutes, so polling it faster than this shows nothing new.
const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;

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
 * Reads what the whole Console organization spent this credit cycle from Anthropic's cost report, so the sidebar
 * also counts usage outside this app. The report needs an organization-scoped service-account (or Admin) key.
 */
export function createClaudeCreditService(dependencies: ClaudeCreditDependencies) {
  const now = dependencies.now ?? Date.now;
  const { config } = dependencies;
  let cache: { key: string; cycleStart: number; today: number; cycle: number; fetchedAt: number } | null = null;
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

  async function fetchSpend(apiKey: string, since: number): Promise<{ today: number; cycle: number }> {
    const todayStart = Math.floor(now() / DAY_MS) * DAY_MS;
    let todayCents = 0;
    let cycleCents = 0;
    let page: string | null = null;
    do {
      const url = new URL(COST_REPORT_URL);
      url.searchParams.set('starting_at', isoSeconds(since));
      url.searchParams.set('ending_at', isoSeconds(todayStart + DAY_MS));
      url.searchParams.set('limit', '31');
      if (page) url.searchParams.set('page', page);
      const response = await dependencies.fetch(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(`Cost report returned ${response.status}${body?.error?.message ? `: ${body.error.message}` : ''}`);
      }
      const body = await response.json() as { data: { starting_at: string; results: { amount: string }[] }[]; has_more: boolean; next_page: string | null };
      for (const bucket of body.data) {
        const cents = bucket.results.reduce((sum, result) => sum + Number(result.amount), 0);
        cycleCents += cents;
        if (Date.parse(bucket.starting_at) === todayStart) todayCents += cents;
      }
      page = body.has_more ? body.next_page : null;
    } while (page);
    return { today: todayCents / 100, cycle: cycleCents / 100 };
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
      org: reading ? { today: reading.today, cycle: reading.cycle, fetchedAt: reading.fetchedAt } : null,
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
