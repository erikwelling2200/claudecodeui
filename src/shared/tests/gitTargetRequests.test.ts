import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';

/**
 * Git requests address one folder of a project. The folder rides next to
 * `project` (query for reads, body for writes) and is left out entirely for
 * the primary folder, so a single-folder project sends exactly what it did
 * before multi-folder projects existed.
 */

const requests: { url: string; body?: unknown }[] = [];

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('reads carry the folder in the query only when one is chosen', async () => {
  await api.git.status({ projectId: 'p1' });
  await api.git.status({ projectId: 'p1', folder: '/work/lib' });

  assert.equal(requests[0].url, '/api/git/status?project=p1');
  assert.equal(requests[1].url, '/api/git/status?project=p1&folder=%2Fwork%2Flib');
});

test('writes carry the folder in the body only when one is chosen', async () => {
  await api.git.commit({ projectId: 'p1', folder: null }, 'msg', ['a.ts']);
  await api.git.commit({ projectId: 'p1', folder: '/work/lib' }, 'msg', ['a.ts']);

  assert.deepEqual(requests[0].body, { project: 'p1', message: 'msg', files: ['a.ts'] });
  assert.deepEqual(requests[1].body, { project: 'p1', folder: '/work/lib', message: 'msg', files: ['a.ts'] });
});

test('updateProject patches the project with the edited fields', async () => {
  await api.updateProject('p1', { displayName: 'App', additionalFolders: ['/work/lib'] });

  assert.equal(requests[0].url, '/api/projects/p1');
  assert.deepEqual(requests[0].body, { displayName: 'App', additionalFolders: ['/work/lib'] });
});
