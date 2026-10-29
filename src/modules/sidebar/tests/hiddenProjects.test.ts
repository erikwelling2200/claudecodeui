import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * A hidden project drops out of the Projects list but stays reachable: the
 * header toggle lists it again (so it can be opened or unhidden), and the
 * Running tab keeps showing its live sessions regardless.
 */

vi.mock('@/shared/api', () => ({
  api: {
    user: { savePreferences: () => Promise.resolve({ ok: true }) },
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
const { readUserPreference } = await import('@/shared/userSettings');

const t = ((key: string) => key) as unknown as TFunction;

const buildProject = (projectId: string): Project => ({
  projectId,
  path: `/${projectId}`,
  fullPath: `/${projectId}`,
  displayName: projectId,
  isStarred: false,
  sessions: [{ id: `${projectId}-session`, summary: 'work', __provider: 'claude' as const }],
  sessionMeta: { hasMore: false, total: 1 },
});

const PROJECTS = [buildProject('alpha'), buildProject('beta')];

const renderController = (activeSessions: Set<string> = new Set()) => renderHook(() => useSidebarController({
  projects: PROJECTS,
  selectedProject: null,
  selectedSession: null,
  activeSessions,
  backgroundSessionIds: new Set<string>(),
  isLoading: false,
  isMobile: false,
  t,
  onRefresh: vi.fn(),
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
  setCurrentProject: vi.fn(),
  setSidebarVisible: vi.fn(),
  sidebarVisible: true,
}));

const listedIds = (projects: Project[]) => projects.map((project) => project.projectId);

test('hiding a project removes it from the list until hidden projects are shown', () => {
  const { result } = renderController();

  act(() => result.current.toggleHiddenProject('alpha'));
  assert.deepEqual(listedIds(result.current.filteredProjects), ['beta']);
  assert.equal(result.current.hiddenProjectsCount, 1);
  assert.deepEqual(readUserPreference('hiddenProjectIds', []), ['alpha']);

  act(() => result.current.toggleShowHiddenProjects());
  assert.deepEqual(listedIds(result.current.filteredProjects), ['alpha', 'beta']);
  assert.equal(result.current.isProjectHidden('alpha'), true);

  act(() => result.current.toggleHiddenProject('alpha'));
  act(() => result.current.toggleShowHiddenProjects());
  assert.deepEqual(listedIds(result.current.filteredProjects), ['alpha', 'beta']);
  assert.equal(result.current.hiddenProjectsCount, 0);
});

test('the Running tab still lists a hidden project with live work', () => {
  const { result } = renderController(new Set(['alpha-session']));

  act(() => result.current.toggleHiddenProject('alpha'));
  act(() => result.current.setSearchMode('running'));
  assert.deepEqual(listedIds(result.current.filteredProjects), ['alpha']);

  act(() => result.current.toggleHiddenProject('alpha'));
});
