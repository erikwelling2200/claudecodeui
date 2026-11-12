import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';
import type { ProjectSession } from '@/shared/types';

/**
 * A turn takes its permission mode when it is sent, so picking a mode while
 * it runs has to be handed to the server separately, or the running turn keeps
 * prompting under the mode it started with.
 */

const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

// What the server answers for the open chat's mode; null when it does not know.
const recorded = vi.hoisted(() => ({ permissionMode: null as string | null, answer: null as Promise<void> | null }));

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: async () => {
        await recorded.answer;
        return okJson({ success: true, data: { model: null, effort: null, permissionMode: recorded.permissionMode } });
      },
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (selectedSession: ProjectSession | null) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const sent: unknown[] = [];
  const hook = renderHook(() =>
    useChatProviderState({ selectedSession, selectedProject: null, sendMessage: (message) => sent.push(message) }),
  );
  return { ...hook, sent };
};

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('picking a mode in an open session sends it to the session\'s running turn', async () => {
  const { result, sent } = await renderProviderState({ id: 'session-1', __provider: 'claude' } as ProjectSession);

  act(() => result.current.selectPermissionMode('auto'));

  assert.deepEqual(sent, [{ type: 'chat.set-permission-mode', sessionId: 'session-1', permissionMode: 'auto' }]);
});

test('cycling with Tab goes through the same path', async () => {
  const { result, sent } = await renderProviderState({ id: 'session-1', __provider: 'claude' } as ProjectSession);

  act(() => result.current.cyclePermissionMode());

  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { permissionMode: string }).permissionMode, result.current.permissionMode);
});

test('a chat with no session yet has nothing running to switch', async () => {
  const { result, sent } = await renderProviderState(null);

  act(() => result.current.selectPermissionMode('auto'));

  assert.deepEqual(sent, []);
});

test('a plan approval records the mode without switching the running turn', async () => {
  const { result, sent } = await renderProviderState({ id: 'session-1', __provider: 'claude' } as ProjectSession);

  act(() => result.current.selectPermissionMode('auto', { applyToLiveTurn: false }));

  assert.deepEqual(sent, [
    { type: 'chat.set-permission-mode', sessionId: 'session-1', permissionMode: 'auto', applyToLiveTurn: false },
  ]);
});

test('a chat with no mode of its own does not take the mode picked in another chat', async () => {
  // Plan was last picked elsewhere; this chat never had a mode picked in it.
  localStorage.setItem('permissionMode-last-claude', 'plan');

  const { result } = await renderProviderState({ id: 'session-b', __provider: 'claude' } as ProjectSession);

  assert.equal(result.current.permissionMode, 'default');
});

test('the mode the server recorded for the chat replaces the local guess', async () => {
  recorded.permissionMode = 'auto';

  const { result } = await renderProviderState({ id: 'session-b', __provider: 'claude' } as ProjectSession);

  await waitFor(() => assert.equal(result.current.permissionMode, 'auto'));
  assert.equal(localStorage.getItem('permissionMode-session-b'), 'auto');
});

test('a pick made before the server answers is not undone by the answer', async () => {
  let answer = () => {};
  recorded.answer = new Promise<void>((resolve) => { answer = resolve; });
  recorded.permissionMode = 'auto';

  const { result } = await renderProviderState({ id: 'session-b', __provider: 'claude' } as ProjectSession);
  act(() => result.current.selectPermissionMode('plan'));
  await act(async () => { answer(); await recorded.answer; });

  assert.equal(result.current.permissionMode, 'plan');
});

test('a new chat keeps the mode picked before it had a session id', async () => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  const { writeSessionPermissionMode } = await import('@/modules/chat/utils/permissionModeStorage');
  const { result, rerender } = renderHook(
    ({ session }: { session: ProjectSession | null }) => useChatProviderState({ selectedSession: session, selectedProject: null }),
    { initialProps: { session: null as ProjectSession | null } },
  );

  act(() => result.current.selectPermissionMode('plan'));
  // What the composer does once the first send has allocated the id.
  writeSessionPermissionMode('new-session', 'plan');
  rerender({ session: { id: 'new-session', __provider: 'claude' } as ProjectSession });

  assert.equal(result.current.permissionMode, 'plan');
});
