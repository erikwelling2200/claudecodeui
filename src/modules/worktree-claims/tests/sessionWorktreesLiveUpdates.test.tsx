import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useSessionWorktrees } from '@/modules/worktree-claims/hooks/useSessionWorktrees';
import { api } from '@/shared/api';
import type { ServerEvent } from '@/shared/types';

/**
 * The worktree-lock hook reports a claim from inside the chat's own CLI, and
 * the server announces it to every socket. The hook here reads the chat's
 * worktrees again on that announcement, and only for the chat it shows.
 */

const SESSION_ID = 'session-a';

function listResponse(data: unknown[]): Response {
  return { ok: true, json: async () => ({ data }) } as unknown as Response;
}

function createSocket() {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: ServerEvent) => {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
}

test('an announcement for the shown chat reads its worktrees again and bumps the revision', async () => {
  let serverState: unknown[] = [];
  const list = vi.spyOn(api.worktreeClaims, 'sessionWorktrees').mockImplementation(async () => listResponse(serverState));
  const socket = createSocket();

  const { result } = renderHook(() => useSessionWorktrees(SESSION_ID, socket.subscribe));
  await waitFor(() => assert.equal(result.current.revision, 1));
  assert.deepEqual(list.mock.calls, [[SESSION_ID]]);

  serverState = [{ sessionId: SESSION_ID, unitKey: 'repo:C:/Unity/ChangefiedPackages', unitName: 'ChangefiedPackages', suffix: 'alt', checkouts: [], claimedAt: '', updatedAt: '' }];
  socket.emit({ kind: 'session_worktrees_changed', sessionId: SESSION_ID });

  await waitFor(() => assert.equal(result.current.revision, 2));
  assert.equal(result.current.worktrees[0]?.suffix, 'alt');
});

test('an announcement for another chat is ignored', async () => {
  const list = vi.spyOn(api.worktreeClaims, 'sessionWorktrees').mockImplementation(async () => listResponse([]));
  const socket = createSocket();

  const { result } = renderHook(() => useSessionWorktrees(SESSION_ID, socket.subscribe));
  await waitFor(() => assert.equal(result.current.revision, 1));

  socket.emit({ kind: 'session_worktrees_changed', sessionId: 'session-b' });
  await act(async () => {});

  assert.equal(list.mock.calls.length, 1);
  assert.equal(result.current.revision, 1);
});
