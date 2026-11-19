import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Escape is the CLI's interrupt key, and the stop button was the only way to
 * reach the same abort here. These drive the real keydown handler so the
 * binding is exercised at the keydown that ships. An open dropdown keeps the
 * key for itself, because its handler runs first and consumes it.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const SESSION: ProjectSession = { id: 'session-abort' };

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      providers: { skills: () => okJson({ success: true, skills: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
      getFiles: () => okJson({ success: true, data: [] }),
    },
  };
});

/** Builds a synthetic textarea Escape keydown, tracking whether it was cancelled. */
const escapeEvent = (overrides: { repeat?: boolean } = {}) => {
  let defaultPrevented = false;
  return {
    event: {
      key: 'Escape',
      repeat: false,
      ...overrides,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false },
      preventDefault: () => {
        defaultPrevented = true;
      },
    } as unknown as KeyboardEvent<HTMLTextAreaElement>,
    wasPrevented: () => defaultPrevented,
  };
};

/** Mounts the composer hook against an open session and a recording sendMessage. */
const renderComposer = (sendMessage: ReturnType<typeof vi.fn>, canAbortSession: boolean) => renderHook(
  () => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: canAbortSession,
    canAbortSession,
    tokenBudget: null,
    sendMessage,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
);

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
});

test('Escape aborts the running turn', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer(sendMessage, true);
  const escape = escapeEvent();

  await act(async () => {
    view.result.current.handleKeyDown(escape.event);
  });

  assert.deepEqual(sendMessage.mock.calls[0][0], {
    type: 'chat.abort',
    sessionId: SESSION.id,
  });
  assert.equal(escape.wasPrevented(), true);
});

test('Escape on an idle session sends nothing', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer(sendMessage, false);
  const escape = escapeEvent();

  await act(async () => {
    view.result.current.handleKeyDown(escape.event);
  });

  assert.equal(sendMessage.mock.calls.length, 0);
  assert.equal(escape.wasPrevented(), false);
});

test('a second Escape while the first is still stopping sends nothing more', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer(sendMessage, true);

  await act(async () => {
    view.result.current.handleKeyDown(escapeEvent().event);
  });
  await act(async () => {
    view.result.current.handleKeyDown(escapeEvent().event);
  });

  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(view.result.current.isStoppingSession, true);
});

test('a held Escape is one interrupt, not one per repeat', async () => {
  const sendMessage = vi.fn();
  const view = renderComposer(sendMessage, true);

  await act(async () => {
    view.result.current.handleKeyDown(escapeEvent({ repeat: true }).event);
  });

  assert.equal(sendMessage.mock.calls.length, 0);
});
