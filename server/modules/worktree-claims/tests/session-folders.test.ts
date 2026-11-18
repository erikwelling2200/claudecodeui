import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { mapFoldersToSessionWorktrees } from '@/modules/worktree-claims/services/session-folders.js';
import { readSuffix, readUnitKey } from '@/modules/worktree-claims/services/unit-keys.js';
import type { SessionWorktree } from '@/shared/types.js';

const unity = path.resolve('Unity');
const packages = path.join(unity, 'ChangefiedPackages');
const packagesAlt = path.join(unity, 'ChangefiedPackages-alt');
const game = path.join(packages, 'Assets', 'Packages', 'GameEditorImprovements');
const vov = path.join(unity, 'Operatie-OV');

function worktree(suffix: string, checkouts: Array<{ repo: string; path: string }>): SessionWorktree {
  return { sessionId: 's1', unitKey: `repo:${checkouts[0].repo}`, unitName: 'ChangefiedPackages', suffix, checkouts, claimedAt: '', updatedAt: '' };
}

test('a claimed repository folder maps onto its checkout', () => {
  const [folder] = mapFoldersToSessionWorktrees([packages], [worktree('alt', [{ repo: packages, path: packagesAlt }])]);
  assert.deepEqual(folder, { path: packagesAlt, mainPath: packages, suffix: 'alt', unitKey: `repo:${packages}` });
});

test('a project folder inside a claimed repository moves along with it', () => {
  const [folder] = mapFoldersToSessionWorktrees([game], [worktree('alt', [{ repo: packages, path: packagesAlt }])]);
  assert.equal(folder.path, path.join(packagesAlt, 'Assets', 'Packages', 'GameEditorImprovements'));
  assert.equal(folder.suffix, 'alt');
});

test('a folder of a unit the chat never claimed stays on main', () => {
  const [folder] = mapFoldersToSessionWorktrees([vov], [worktree('alt', [{ repo: packages, path: packagesAlt }])]);
  assert.deepEqual(folder, { path: vov, mainPath: vov, suffix: '', unitKey: null });
});

test('a later claim of the main checkout puts the folder back on main', () => {
  const [folder] = mapFoldersToSessionWorktrees([packages], [worktree('', [{ repo: packages, path: packages }])]);
  assert.equal(folder.path, packages);
  assert.equal(folder.suffix, '');
});

test('unit keys and suffixes are validated the way the lock files spell them', () => {
  assert.equal(readUnitKey('repo:C:/Unity/ChangefiedPackages'), 'repo:C:/Unity/ChangefiedPackages');
  assert.equal(readUnitKey('group:unity'), 'group:unity');
  assert.throws(() => readUnitKey('ChangefiedPackages'), /not a worktree unit key/);
  assert.throws(() => readUnitKey(undefined), /not a worktree unit key/);
  assert.equal(readSuffix('alt', 'suffix'), 'alt');
  assert.equal(readSuffix('', 'suffix'), '');
  assert.throws(() => readSuffix('a b', 'suffix'), /worktree suffix/);
  assert.throws(() => readSuffix(undefined, 'suffix'), /worktree suffix/);
});
