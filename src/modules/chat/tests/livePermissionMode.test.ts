import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
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

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
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
