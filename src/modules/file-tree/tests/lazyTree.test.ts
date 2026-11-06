import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { FileSearchResult, FileTreeNode } from '@/shared/types';
import {
  buildSearchResultTree,
  collectDirectoriesToLoad,
  setDirectoryChildren,
} from '@/modules/file-tree/utils/fileTreeUtils';

const ROOT = '/work/app';

const directory = (relativePath: string, children?: FileTreeNode[]): FileTreeNode => ({
  name: relativePath.split('/').pop()!,
  path: `${ROOT}/${relativePath}`,
  type: 'directory',
  children,
});
const file = (relativePath: string): FileTreeNode => ({
  name: relativePath.split('/').pop()!,
  path: `${ROOT}/${relativePath}`,
  type: 'file',
});

test('with one level of prefetch, only the contents of visible folders are loaded', () => {
  const tree = [
    directory('src', [directory('src/lib'), file('src/index.ts')]),
    directory('docs'),
  ];

  // Nothing expanded: src and docs are visible, so their contents are wanted; src's are already there.
  assert.deepEqual([...collectDirectoriesToLoad(tree, new Set(), 1)], [[`${ROOT}/docs`, 1]]);

  // src expanded: src/lib is now visible, so its contents are wanted too.
  assert.deepEqual(
    [...collectDirectoriesToLoad(tree, new Set([`${ROOT}/src`]), 1)],
    [[`${ROOT}/src/lib`, 1], [`${ROOT}/docs`, 1]],
  );
});

test('a larger prefetch depth asks for the missing levels in one request', () => {
  const tree = [directory('src')];

  assert.deepEqual([...collectDirectoriesToLoad(tree, new Set(), 2)], [[`${ROOT}/src`, 2]]);
  // An expanded folder whose contents are missing needs them plus the prefetch below.
  assert.deepEqual([...collectDirectoriesToLoad(tree, new Set([`${ROOT}/src`]), 2)], [[`${ROOT}/src`, 3]]);
});

test('a folder inside a collapsed folder is not opened by being in the expanded set', () => {
  const tree = [directory('src', [directory('src/lib', [directory('src/lib/deep')])])];

  // src/lib is expanded but src is not, so src/lib/deep is two levels below the screen.
  assert.deepEqual([...collectDirectoriesToLoad(tree, new Set([`${ROOT}/src/lib`]), 1)], []);
});

test('a fresh listing keeps what was loaded deeper down', () => {
  const tree = [directory('src', [directory('src/lib', [file('src/lib/a.ts')])])];

  const next = setDirectoryChildren(tree, `${ROOT}/src`, [directory('src/lib'), file('src/new.ts')]);

  assert.deepEqual(next[0].children?.map((node) => node.name), ['lib', 'new.ts']);
  assert.deepEqual(next[0].children?.[0].children?.map((node) => node.name), ['a.ts']);
});

test('a listing for a directory not in the tree leaves the tree untouched', () => {
  const tree = [directory('src', [])];

  assert.equal(setDirectoryChildren(tree, `${ROOT}/gone`, [file('gone/x.ts')]), tree);
});

test('search results are laid out under their folders, with the server separator', () => {
  const windowsRoot = 'C:\\work\\app';
  const results: FileSearchResult[] = [{
    name: 'Player.cs',
    path: `${windowsRoot}\\Assets\\Scripts\\Player.cs`,
    relativePath: 'Assets/Scripts/Player.cs',
    type: 'file',
    rootPath: windowsRoot,
    rootIndex: 0,
  }];

  const tree = buildSearchResultTree(results, []);

  assert.equal(tree[0].path, `${windowsRoot}\\Assets`);
  assert.equal(tree[0].children?.[0].path, `${windowsRoot}\\Assets\\Scripts`);
  assert.equal(tree[0].children?.[0].children?.[0].path, `${windowsRoot}\\Assets\\Scripts\\Player.cs`);
});

test('in a multi-folder project each result goes under its own folder node', () => {
  const extra = '/work/lib';
  const roots: FileTreeNode[] = [
    { name: 'app', path: ROOT, type: 'directory', isProjectRoot: true, children: [] },
    { name: 'lib', path: extra, type: 'directory', isProjectRoot: true, children: [] },
  ];
  const results: FileSearchResult[] = [
    { name: 'util.ts', path: `${extra}/util.ts`, relativePath: 'util.ts', type: 'file', rootPath: extra, rootIndex: 1 },
  ];

  const tree = buildSearchResultTree(results, roots);

  assert.deepEqual(tree.map((node) => node.children?.map((child) => child.name)), [[], ['util.ts']]);
});
