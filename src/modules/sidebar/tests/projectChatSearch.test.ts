import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';
import { filterProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * The Projects search keeps a project whose name matches with all its chats, and a
 * project whose name does not match with only the chats whose title does.
 */

const makeSession = (id: string, summary: string): ProjectSession => ({ id, summary, lastActivity: '2026-11-20T00:00:00Z' });

const makeProject = (projectId: string, displayName: string, sessions: ProjectSession[]): Project => ({
  projectId,
  displayName,
  path: `C:/repos/${displayName}`,
  sessions,
  sessionMeta: { total: 40, hasMore: true },
} as Project);

const projects = [
  makeProject('p1', 'claudecodeui', [makeSession('s1', 'Sidebar chat search'), makeSession('s2', 'Fix restart button')]),
  makeProject('p2', 'Operatie-OV', [makeSession('s3', 'Bus stop SEARCH bug'), makeSession('s4', 'Pause menu')]),
  makeProject('p3', 'DeviceSetup', [makeSession('s5', 'Rack matrix')]),
];

test('a project whose name matches keeps every chat', () => {
  const { projects: result, chatMatchedProjectIds } = filterProjects(projects, 'claudecode');
  assert.deepEqual(result.map((project) => project.projectId), ['p1']);
  assert.equal(result[0], projects[0]);
  assert.equal(chatMatchedProjectIds.size, 0);
});

test('a project found through its chats lists only the matching chats and opens', () => {
  const { projects: result, chatMatchedProjectIds } = filterProjects(projects, 'search');
  assert.deepEqual(result.map((project) => project.projectId), ['p1', 'p2']);
  assert.deepEqual(result[0].sessions?.map((session) => session.id), ['s1']);
  assert.deepEqual(result[1].sessions?.map((session) => session.id), ['s3']);
  assert.deepEqual(result[1].sessionMeta, { total: 1, hasMore: false });
  assert.deepEqual([...chatMatchedProjectIds], ['p1', 'p2']);
});

test('an empty search returns the list untouched', () => {
  const { projects: result } = filterProjects(projects, '  ');
  assert.equal(result, projects);
});
