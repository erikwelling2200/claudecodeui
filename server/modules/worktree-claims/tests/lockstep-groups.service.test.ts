import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  readProjectLockstepGroups,
  saveProjectLockstepGroups,
} from '@/modules/worktree-claims/services/lockstep-groups.service.js';

const root = path.resolve('/work');
const [repoA, repoB, repoC, repoD] = ['A', 'B', 'C', 'D'].map((name) => path.join(root, name));

async function groupsFileWith(content: unknown): Promise<string> {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'lockstep-')), 'worktree-groups.json');
  if (content !== undefined) await writeFile(file, JSON.stringify(content));
  return file;
}

test('a missing groups file means no groups', async () => {
  const file = await groupsFileWith(undefined);
  assert.deepEqual(await readProjectLockstepGroups([repoA, repoB], file), { folders: [repoA, repoB], groups: [] });
});

test('reading returns only groups that involve the project', async () => {
  const file = await groupsFileWith({ groups: [{ name: 'ab', repos: [repoA, repoB] }, { name: 'other', repos: ['/elsewhere/x', '/elsewhere/y'] }] });
  const result = await readProjectLockstepGroups([repoA, repoB, repoC], file);
  assert.deepEqual(result.groups.map((group) => group.name), ['ab']);
});

test('saving replaces the project groups and keeps other projects and extra keys', async () => {
  const unityMcp = { 'unity-a': repoA };
  const file = await groupsFileWith({ groups: [{ name: 'ab', repos: [repoA, repoB] }, { name: 'other', repos: ['/elsewhere/x', '/elsewhere/y'] }], unityMcp });
  await saveProjectLockstepGroups([repoA, repoB, repoC], [{ name: ' abc ', repos: [repoA, repoB, repoC] }], file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.groups, [{ name: 'other', repos: ['/elsewhere/x', '/elsewhere/y'] }, { name: 'abc', repos: [repoA, repoB, repoC] }]);
  assert.deepEqual(saved.unityMcp, unityMcp);
});

test('saving rejects invalid groups', async () => {
  const file = await groupsFileWith({ groups: [{ name: 'other', repos: [repoD, '/elsewhere/y'] }] });
  const folders = [repoA, repoB, repoC];
  const cases: Array<[string, Array<{ name: string; repos: string[] }>]> = [
    ['needs a name', [{ name: ' ', repos: [repoA, repoB] }]],
    ['at least two', [{ name: 'a', repos: [repoA] }]],
    ['not a folder of this project', [{ name: 'a', repos: [repoA, '/nowhere'] }]],
    ['already in lockstep group "x"', [{ name: 'x', repos: [repoA, repoB] }, { name: 'y', repos: [repoB, repoC] }]],
    ['already a lockstep group named "other"', [{ name: 'other', repos: [repoA, repoB] }]],
  ];
  for (const [message, groups] of cases) {
    await assert.rejects(saveProjectLockstepGroups(folders, groups, file), (error: Error) => error.message.includes(message), message);
  }
});
