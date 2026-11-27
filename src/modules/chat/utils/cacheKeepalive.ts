import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';

/**
 * Whether a chat's prompt cache is kept warm, as the server reports it. The server owns the setting: it pings the
 * cache, switches the setting off after 20 hours without a turn, and announces every change with a `cache_keepalive`
 * event, so every open client shows the same state.
 */
export type CacheKeepalivePing = {
  at: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  error?: string;
};

export type CacheKeepaliveState = {
  enabled: boolean;
  until: string | null;
  nextPingAt: string | null;
  lastPing: CacheKeepalivePing | null;
};

type Listener = () => void;

const listeners = new Set<Listener>();
const states = new Map<string, CacheKeepaliveState>();
const requested = new Set<string>();

function publish(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readState(value: Record<string, unknown>): CacheKeepaliveState {
  return {
    enabled: value.enabled === true,
    until: typeof value.until === 'string' ? value.until : null,
    nextPingAt: typeof value.nextPingAt === 'string' ? value.nextPingAt : null,
    lastPing: value.lastPing && typeof value.lastPing === 'object' ? value.lastPing as CacheKeepalivePing : null,
  };
}

async function load(sessionId: string): Promise<void> {
  const response = await api.cacheKeepalive.get(sessionId);
  if (!response.ok) {
    throw new Error(`Loading the cache keepalive of ${sessionId} failed with ${response.status}.`);
  }
  const payload = await response.json();
  states.set(sessionId, readState(payload.data));
  publish();
}

/** Applies a `cache_keepalive` event from the server. */
export function applyCacheKeepaliveEvent(sessionId: string, event: Record<string, unknown>): void {
  states.set(sessionId, readState(event));
  publish();
}

export async function setCacheKeepalive(sessionId: string, enabled: boolean): Promise<void> {
  const response = await api.cacheKeepalive.set(sessionId, enabled);
  if (!response.ok) {
    throw new Error(`Turning the cache keepalive of ${sessionId} ${enabled ? 'on' : 'off'} failed with ${response.status}.`);
  }
  const payload = await response.json();
  states.set(sessionId, readState(payload.data));
  publish();
}

/** The chat's keepalive state; null until the server has answered, and for a chat without a session id. */
export function useCacheKeepalive(sessionId: string | null): CacheKeepaliveState | null {
  useEffect(() => {
    if (!sessionId || requested.has(sessionId)) return;
    requested.add(sessionId);
    load(sessionId).catch((error: unknown) => {
      requested.delete(sessionId);
      console.error(error);
    });
  }, [sessionId]);
  return useSyncExternalStore(subscribe, () => (sessionId ? states.get(sessionId) ?? null : null));
}
