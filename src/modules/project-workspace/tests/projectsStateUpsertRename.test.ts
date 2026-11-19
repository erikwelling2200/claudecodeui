import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A chat renamed outside this tab (by its agent through `set_chat_name`, another tab or the CLI) reaches the client only
 * as a `session_upserted`. The workspace header reads `selectedSession`, so the upsert has to retitle that copy too, not
 * only the sidebar row.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const session: ProjectSession = { id: 'session-1', summary: 'Original title', __provider: 'claude' };
const otherSession: ProjectSession = { id: 'session-2', summary: 'Untouched', __provider: 'claude' };

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'repo',
  isStarred: false,
  sessions: [session, otherSession],
  sessionMeta: { hasMore: false, total: 2 },
};

const upsert = (sessionId: string, summary: string): ServerEvent => ({
  kind: 'session_upserted',
  sessionId,
  provider: 'claude',
  session: { id: sessionId, summary, __provider: 'claude' },
  project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'repo', isStarred: false },
}) as unknown as ServerEvent;

const renderWithSelectedSession = async (selected: ProjectSession = session) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
  let listener: ((event: ServerEvent) => void) | null = null;
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  const { result } = renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      sendMessage: () => {},
      subscribe: (handler: (event: ServerEvent) => void) => {
        listener = handler;
        return () => {};
      },
      isMobile: false,
      // Processing, so the upsert is not taken for an external transcript edit that reloads the chat.
      isSessionProcessing: () => true,
    }),
  );

  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  act(() => {
    result.current.handleSessionSelect({ ...selected, __projectId: 'project-1' });
  });

  const emit = (event: ServerEvent) => act(() => {
    assert.ok(listener);
    listener(event);
  });
  return { result, emit };
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

test('an upsert that retitles the open session updates the header copy', async () => {
  const { result, emit } = await renderWithSelectedSession();

  emit(upsert('session-1', 'Named by agent'));

  assert.equal(result.current.selectedSession?.summary, 'Named by agent');
  assert.equal(result.current.projects[0].sessions?.[0].summary, 'Named by agent');
});

test('an upsert with the same title keeps the selected object identity', async () => {
  const { result, emit } = await renderWithSelectedSession();
  const selectedBefore = result.current.selectedSession;

  emit(upsert('session-1', 'Original title'));

  assert.equal(result.current.selectedSession, selectedBefore);
});

test('an upsert with an empty title does not blank the header', async () => {
  const { result, emit } = await renderWithSelectedSession();

  emit(upsert('session-1', ''));

  assert.equal(result.current.selectedSession?.summary, 'Original title');
});

test('an upsert for another session leaves the selection untouched', async () => {
  const { result, emit } = await renderWithSelectedSession();
  const selectedBefore = result.current.selectedSession;

  emit(upsert('session-2', 'Other renamed'));

  assert.equal(result.current.selectedSession, selectedBefore);
});

test('an upsert rename leaves the one-shot search jump target behind', async () => {
  const { result, emit } = await renderWithSelectedSession({ ...session, __searchTargetSnippet: 'matched text' });
  assert.equal(result.current.selectedSession?.__searchTargetSnippet, 'matched text');

  emit(upsert('session-1', 'Named by agent'));

  assert.equal(result.current.selectedSession?.summary, 'Named by agent');
  assert.equal('__searchTargetSnippet' in (result.current.selectedSession ?? {}), false);
});
