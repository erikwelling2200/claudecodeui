import { useSyncExternalStore } from 'react';

import type { QueuedDraft } from '@/shared/types';

/**
 * A message sent while a Claude turn ran, from the moment it is sent until the
 * CLI takes it into the turn (the server then sends it as a user message where
 * the model read it), the turn ends, or the server declines it.
 */
export type PendingSteer = {
  steerId: string;
  sessionId: string;
  content: string;
  attachmentCount: number;
  /** Set once the user asked to interrupt the turn so it goes in at once. */
  interrupting: boolean;
  /** What to send another way should the server decline it; only the tab that sent it has this. */
  resend?: QueuedDraft;
};

type Listener = () => void;

let steers: PendingSteer[] = [];
const listeners = new Set<Listener>();
const EMPTY: PendingSteer[] = [];
const bySession = new Map<string, PendingSteer[]>();

function publish(next: PendingSteer[]): void {
  steers = next;
  bySession.clear();
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

export function listPendingSteers(sessionId: string): PendingSteer[] {
  let list = bySession.get(sessionId);
  if (!list) {
    list = steers.filter((steer) => steer.sessionId === sessionId);
    bySession.set(sessionId, list.length > 0 ? list : EMPTY);
  }
  return list.length > 0 ? list : EMPTY;
}

/** Adds a waiting message, or fills in what another tab's announcement lacked. */
export function addPendingSteer(steer: Omit<PendingSteer, 'interrupting'> & { interrupting?: boolean }): void {
  const existing = steers.find((candidate) => candidate.steerId === steer.steerId);
  if (existing) {
    publish(steers.map((candidate) => (candidate === existing
      ? { ...existing, resend: existing.resend ?? steer.resend }
      : candidate)));
    return;
  }
  publish([...steers, { ...steer, interrupting: steer.interrupting ?? false }]);
}

/** Removes a waiting message and returns it, or null when it was not waiting. */
export function takePendingSteer(steerId: string): PendingSteer | null {
  const steer = steers.find((candidate) => candidate.steerId === steerId) ?? null;
  if (steer) {
    publish(steers.filter((candidate) => candidate !== steer));
  }
  return steer;
}

/** Forgets every message a session had waiting, once its turn has ended. */
export function clearPendingSteers(sessionId: string): void {
  if (steers.some((steer) => steer.sessionId === sessionId)) {
    publish(steers.filter((steer) => steer.sessionId !== sessionId));
  }
}

const declinedListeners = new Set<(steer: PendingSteer) => void>();

/** Hears of a waiting message the server declined, so its sender can send it another way. */
export function onPendingSteerDeclined(listener: (steer: PendingSteer) => void): () => void {
  declinedListeners.add(listener);
  return () => {
    declinedListeners.delete(listener);
  };
}

export function declinePendingSteer(steerId: string): void {
  const steer = takePendingSteer(steerId);
  if (steer) {
    for (const listener of declinedListeners) {
      listener(steer);
    }
  }
}

export function markPendingSteerInterrupting(steerId: string): void {
  publish(steers.map((steer) => (steer.steerId === steerId ? { ...steer, interrupting: true } : steer)));
}

export function resetPendingSteers(): void {
  publish([]);
}

/** The messages a session has waiting to go into its running turn, oldest first. */
export function usePendingSteers(sessionId: string | null): PendingSteer[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? listPendingSteers(sessionId) : EMPTY));
}
