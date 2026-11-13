import { useCallback, useSyncExternalStore } from 'react';

import type { SessionPrompt } from '@/shared/types';

/**
 * Messages the user pinned in a chat, kept in this browser's localStorage per session and listed in the sidebar beside
 * the chat. A pin is identified by its message's timestamp, which is also what the sidebar's jump back to it resolves.
 */

const STORAGE_PREFIX = 'chat-pinned-messages:';
// The sidebar shows three lines of a pin, so a long reply needs only its start stored.
const MAX_PIN_TEXT_LENGTH = 2000;
const EMPTY: SessionPrompt[] = [];

// Parsed per session, so every subscriber gets the same array until the pins change.
const cache = new Map<string, SessionPrompt[]>();
const listeners = new Set<() => void>();

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export function readPinnedMessages(sessionId: string): SessionPrompt[] {
  const cached = cache.get(sessionId);
  if (cached) return cached;
  const raw = window.localStorage.getItem(storageKey(sessionId));
  const pins = raw ? (JSON.parse(raw) as SessionPrompt[]) : EMPTY;
  cache.set(sessionId, pins);
  return pins;
}

function writePinnedMessages(sessionId: string, pins: SessionPrompt[]) {
  if (pins.length) window.localStorage.setItem(storageKey(sessionId), JSON.stringify(pins));
  else window.localStorage.removeItem(storageKey(sessionId));
  cache.set(sessionId, pins);
  listeners.forEach((listener) => listener());
}

/** Pins the message, or unpins it when a pin with the same timestamp exists. Pins stay in transcript order. */
export function togglePinnedMessage(sessionId: string, message: SessionPrompt) {
  const pins = readPinnedMessages(sessionId);
  if (pins.some((pin) => pin.timestamp === message.timestamp)) {
    writePinnedMessages(sessionId, pins.filter((pin) => pin.timestamp !== message.timestamp));
    return;
  }
  const pin = { text: message.text.slice(0, MAX_PIN_TEXT_LENGTH), timestamp: message.timestamp };
  const sorted = [...pins, pin].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  writePinnedMessages(sessionId, sorted);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab pinning in the same chat.
  const onStorage = (event: StorageEvent) => {
    if (!event.key?.startsWith(STORAGE_PREFIX)) return;
    cache.delete(event.key.slice(STORAGE_PREFIX.length));
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The pins of `sessionId`, re-rendering on every change; empty for a chat without a session yet. */
export function usePinnedMessages(sessionId: string | null): SessionPrompt[] {
  const getSnapshot = useCallback(() => (sessionId ? readPinnedMessages(sessionId) : EMPTY), [sessionId]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
