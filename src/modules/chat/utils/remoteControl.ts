import { useSyncExternalStore } from 'react';

/**
 * Remote Control per Claude chat: whether the user wants it on, and the
 * claude.ai URL of the bridge while the chat's process runs one.
 *
 * The wish is stored per session, plus a "last" key a brand-new chat reads
 * until it has a session id. A turn that launches a process carries the wish
 * and the server starts the bridge then; a toggle while the process runs
 * starts or stops it there and then. The server records the wish as well and
 * reports every change to it, which is how a chat's threads follow the chat.
 */
export type RemoteControlStatus = {
  wanted: boolean;
  /** The claude.ai session the bridge shows; null while no bridge runs. */
  sessionUrl: string | null;
};

type Listener = () => void;

const LAST_KEY = 'remoteControl-last';
const listeners = new Set<Listener>();
const sessionUrls = new Map<string, string>();
const snapshots = new Map<string, RemoteControlStatus>();

const storageKey = (sessionId: string | null): string => (sessionId ? `remoteControl-${sessionId}` : LAST_KEY);

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // The toggle still holds for this page; it is just not remembered.
  }
}

function publish(): void {
  snapshots.clear();
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

export function readRemoteControlWanted(sessionId: string | null): boolean {
  const stored = (sessionId ? readStored(storageKey(sessionId)) : null) ?? readStored(LAST_KEY);
  return stored === '1';
}

export function setRemoteControlWanted(sessionId: string | null, wanted: boolean): void {
  writeStored(LAST_KEY, wanted);
  if (sessionId) {
    writeStored(storageKey(sessionId), wanted);
  }
  publish();
}

/** Applies a `remote_control` event from the server, which carries the session's wish. A bridge that failed to start turns it off. */
export function applyRemoteControlEvent(sessionId: string, event: { enabled?: unknown; sessionUrl?: unknown; error?: unknown }): void {
  if (event.enabled === true && typeof event.sessionUrl === 'string' && event.sessionUrl) {
    sessionUrls.set(sessionId, event.sessionUrl);
  } else {
    sessionUrls.delete(sessionId);
  }
  if (typeof event.enabled === 'boolean') {
    writeStored(storageKey(sessionId), event.enabled);
  }
  if (event.error) {
    writeStored(LAST_KEY, false);
  }
  publish();
}

function getSnapshot(sessionId: string | null): RemoteControlStatus {
  const key = sessionId ?? '';
  let snapshot = snapshots.get(key);
  if (!snapshot) {
    snapshot = {
      wanted: readRemoteControlWanted(sessionId),
      sessionUrl: sessionId ? sessionUrls.get(sessionId) ?? null : null,
    };
    snapshots.set(key, snapshot);
  }
  return snapshot;
}

export function useRemoteControl(sessionId: string | null): RemoteControlStatus {
  return useSyncExternalStore(subscribe, () => getSnapshot(sessionId), () => getSnapshot(sessionId));
}
