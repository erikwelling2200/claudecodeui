import { sessionsDb } from '@/modules/database/index.js';
import { WS_OPEN_STATE, chatRunRegistry, connectedClients, onRunSettled, onTurnDispatched } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import type { AnyRecord, CacheWarmResult, LLMProvider } from '@/shared/types.js';

// Claude Code caches a chat's prompt for an hour, and every request that reads the cache starts that hour again.
export const CACHE_TTL_MS = 60 * 60_000;
// Five minutes short of the hour leaves room for a ping whose process is slow to start, and for a failed one to retry.
export const PING_AFTER_MS = 55 * 60_000;
// A chat left alone this long is probably done with; past it, a ping per hour costs more than one cold start.
export const KEEPALIVE_WINDOW_MS = 20 * 60 * 60_000;
const TICK_MS = 60_000;

export type CacheKeepalivePing = { at: string } & (CacheWarmResult | { error: string });

export type CacheKeepaliveMiss = { at: string } & CacheWarmResult;

export type CacheKeepaliveState = {
  enabled: boolean;
  /** When keeping the cache warm switches itself off unless the chat runs another turn first. */
  until: string | null;
  /** When the next ping goes out; null while no turn has run since the server started, or the cache has expired. */
  nextPingAt: string | null;
  lastPing: CacheKeepalivePing | null;
  /** The ping that missed the cache and so switched keepalive off; cleared when it is switched on again. */
  stoppedByMiss: CacheKeepaliveMiss | null;
};

/** A ping that writes more than it reads did not find the conversation in the cache, so its pings only pay for rewriting it. */
export function isCacheMiss(result: CacheWarmResult): boolean {
  return result.cacheWriteTokens > result.cacheReadTokens;
}

/** What the timer does for one chat on a tick. */
export function decideKeepalive(input: { now: number; until: number; warmAt: number | undefined; canPing: boolean; busy: boolean }): 'disable' | 'ping' | 'wait' {
  if (input.now >= input.until) return 'disable';
  if (input.busy || !input.canPing || input.warmAt === undefined) return 'wait';
  const elapsed = input.now - input.warmAt;
  // Past the hour the cache is gone and a ping would pay for the whole conversation again; the next turn does that anyway.
  return elapsed >= PING_AFTER_MS && elapsed < CACHE_TTL_MS ? 'ping' : 'wait';
}

/** The chat's last turn options minus what belonged to that one message. */
function pingOptions(options: AnyRecord): AnyRecord {
  const {
    attachments: _attachments,
    images: _images,
    files: _files,
    followUpInstruction: _followUpInstruction,
    remoteControl: _remoteControl,
    resumeAnchorId: _resumeAnchorId,
    resumeFromScratch: _resumeFromScratch,
    ...rest
  } = options;
  return rest;
}

/** Options of each chat's last turn, which its pings reuse. */
const lastTurnOptions = new Map<string, { provider: LLMProvider; options: AnyRecord }>();
/** When each chat's cache was last read or written, by a turn or a ping. */
const warmAt = new Map<string, number>();
const lastPings = new Map<string, CacheKeepalivePing>();
const misses = new Map<string, CacheKeepaliveMiss>();
const pinging = new Set<string>();
let runtime: Pick<ProviderRuntimeGateway, 'warmCache'> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribers: Array<() => void> = [];

function getState(sessionId: string): CacheKeepaliveState {
  const until = sessionsDb.getSessionById(sessionId)?.cache_keepalive_until ?? null;
  const warm = warmAt.get(sessionId);
  const live = warm !== undefined && lastTurnOptions.has(sessionId) && Date.now() - warm < CACHE_TTL_MS;
  return {
    enabled: until !== null,
    until,
    nextPingAt: until !== null && live ? new Date(warm + PING_AFTER_MS).toISOString() : null,
    lastPing: until !== null ? lastPings.get(sessionId) ?? null : null,
    stoppedByMiss: until === null ? misses.get(sessionId) ?? null : null,
  };
}

function broadcast(sessionId: string): void {
  const payload = JSON.stringify({ kind: 'cache_keepalive', sessionId, timestamp: new Date().toISOString(), ...getState(sessionId) });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function setUntil(sessionId: string, until: string | null): void {
  sessionsDb.setSessionCacheKeepaliveUntil(sessionId, until);
  if (until === null) {
    lastPings.delete(sessionId);
  }
}

/** Keeps a ping's result, and switches keepalive off when the ping missed the cache. */
export function recordPing(sessionId: string, at: string, result: CacheWarmResult): void {
  warmAt.set(sessionId, Date.now());
  lastPings.set(sessionId, { at, ...result });
  console.log(`[CacheKeepalive] Pinged chat ${sessionId}: ${result.cacheReadTokens} tokens read from cache, ${result.cacheWriteTokens} written.`);
  if (isCacheMiss(result)) {
    setUntil(sessionId, null);
    misses.set(sessionId, { at, ...result });
    console.log(`[CacheKeepalive] Stopped keeping chat ${sessionId} warm: its ping missed the cache.`);
  }
}

async function ping(sessionId: string): Promise<void> {
  const turn = lastTurnOptions.get(sessionId);
  if (!runtime || !turn) return;
  pinging.add(sessionId);
  const at = new Date().toISOString();
  try {
    const result = await runtime.warmCache(turn.provider, sessionId, pingOptions(turn.options));
    if (result) {
      recordPing(sessionId, at, result);
    } else {
      lastPings.set(sessionId, { at, error: 'The chat has nothing to resume yet.' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastPings.set(sessionId, { at, error: message });
    console.error(`[CacheKeepalive] Pinging chat ${sessionId} failed: ${message}`);
  } finally {
    pinging.delete(sessionId);
    broadcast(sessionId);
  }
}

/** One pass over every chat with keepalive on: pings the ones due, and switches off the ones idle for too long. */
export async function runKeepaliveTick(now = Date.now()): Promise<void> {
  const pings: Array<Promise<void>> = [];
  for (const row of sessionsDb.listCacheKeepaliveSessions()) {
    const sessionId = row.session_id;
    const decision = decideKeepalive({
      now,
      until: Date.parse(row.cache_keepalive_until),
      warmAt: warmAt.get(sessionId),
      canPing: lastTurnOptions.has(sessionId),
      busy: chatRunRegistry.isProcessing(sessionId) || pinging.has(sessionId),
    });
    if (decision === 'disable') {
      setUntil(sessionId, null);
      broadcast(sessionId);
    } else if (decision === 'ping') {
      pings.push(ping(sessionId));
    }
  }
  await Promise.all(pings);
}

export const cacheKeepaliveService = {
  getState,

  setEnabled(sessionId: string, enabled: boolean): CacheKeepaliveState {
    misses.delete(sessionId);
    setUntil(sessionId, enabled ? new Date(Date.now() + KEEPALIVE_WINDOW_MS).toISOString() : null);
    broadcast(sessionId);
    return getState(sessionId);
  },
};

/** Starts the timer and follows every chat's turns, which restart both the cache's hour and the 20-hour window. */
export function initializeCacheKeepalive(gateway: Pick<ProviderRuntimeGateway, 'warmCache'>, options: { tickMs?: number } = {}): void {
  closeCacheKeepalive();
  runtime = gateway;
  unsubscribers = [
    onTurnDispatched((sessionId, provider, turnOptions) => {
      lastTurnOptions.set(sessionId, { provider, options: turnOptions });
    }),
    onRunSettled((sessionId) => {
      warmAt.set(sessionId, Date.now());
      if (sessionsDb.getSessionById(sessionId)?.cache_keepalive_until) {
        setUntil(sessionId, new Date(Date.now() + KEEPALIVE_WINDOW_MS).toISOString());
        broadcast(sessionId);
      }
    }),
  ];
  timer = setInterval(() => {
    void runKeepaliveTick();
  }, options.tickMs ?? TICK_MS);
  timer.unref?.();
}

export function closeCacheKeepalive(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  if (timer) clearInterval(timer);
  timer = null;
  runtime = null;
  lastTurnOptions.clear();
  warmAt.clear();
  lastPings.clear();
  misses.clear();
  pinging.clear();
}
