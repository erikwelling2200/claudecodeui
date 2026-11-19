import { useCallback, useState } from 'react';

import { api, readApiJson } from '@/shared/api';

export type ServerRestartStatus = 'idle' | 'restarting' | 'failed';

const HEALTH_POLL_INTERVAL_MS = 1000;
// Startup after a restart includes a database open and plugin starts; well under this on every machine seen so far.
const RESTART_TIMEOUT_MS = 120_000;

/** The unauthenticated health endpoint's start stamp, or null when the server does not answer. */
async function readServerStartedAt(): Promise<string | null> {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.startedAt === 'string' ? data.startedAt : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true once a server with a different start stamp answers, false when none does before the timeout. */
async function waitForReplacementServer(previousStartedAt: string | null): Promise<boolean> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_INTERVAL_MS);
    const startedAt = await readServerStartedAt();
    if (startedAt !== null && startedAt !== previousStartedAt) return true;
  }
  return false;
}

/**
 * Used by ServerRestartButton: asks the server to restart itself, waits for the new process to answer, then reloads
 * the page so every websocket and cached state starts fresh against it.
 */
export function useServerRestart() {
  // Drives the button's look while the server is down and after a restart that never came back.
  const [status, setStatus] = useState<ServerRestartStatus>('idle');

  const restart = useCallback(async () => {
    setStatus('restarting');
    try {
      const previousStartedAt = await readServerStartedAt();
      await readApiJson(await api.system.restart());
      if (await waitForReplacementServer(previousStartedAt)) {
        window.location.reload();
        return;
      }
    } catch (error) {
      console.error('Server restart failed:', error);
    }
    setStatus('failed');
  }, []);

  return { status, restart };
}
