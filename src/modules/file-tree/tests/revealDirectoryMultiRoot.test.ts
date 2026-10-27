import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useExpandedDirectories } from '@/modules/file-tree/hooks/useExpandedDirectories';
import { directoryRevealPaths } from '@/modules/file-tree/utils/revealDirectory';
import type { FileTreeNode } from '@/shared/types';

/**
 * A multi-folder project lists one top-level node per folder, primary first.
 * Relative references belong to the primary folder; absolute ones to the
 * folder containing them, the deepest one when folders are nested.
 */

const PRIMARY = 'C:/Unity/Operatie-OV';
const PACKAGES = 'C:/Unity/ChangefiedPackages';
const NESTED = `${PACKAGES}/Assets/Packages/Misc`;

const files = [
  {
    type: 'directory',
    name: 'Operatie-OV',
    path: PRIMARY,
    isProjectRoot: true,
    children: [
      {
        type: 'directory',
        name: 'Assets',
        path: `${PRIMARY}/Assets`,
        children: [{ type: 'directory', name: 'Scripts', path: `${PRIMARY}/Assets/Scripts`, children: [] }],
      },
    ],
  },
  {
    type: 'directory',
    name: 'ChangefiedPackages',
    path: PACKAGES,
    isProjectRoot: true,
    children: [{ type: 'directory', name: 'Assets', path: `${PACKAGES}/Assets`, children: [] }],
  },
  {
    type: 'directory',
    name: 'Misc',
    path: NESTED,
    isProjectRoot: true,
    children: [{ type: 'directory', name: 'Runtime', path: `${NESTED}/Runtime`, children: [] }],
  },
] as unknown as FileTreeNode[];

test('a relative reference resolves inside the primary folder node', () => {
  assert.deepEqual(directoryRevealPaths(files, PRIMARY, 'Assets/Scripts/'), [
    PRIMARY,
    `${PRIMARY}/Assets`,
    `${PRIMARY}/Assets/Scripts`,
  ]);
});

test('an absolute reference resolves inside the folder node that contains it', () => {
  assert.deepEqual(directoryRevealPaths(files, PRIMARY, `${PACKAGES}/Assets`), [PACKAGES, `${PACKAGES}/Assets`]);
});

test('a nested folder wins over the outer folder that also contains the path', () => {
  assert.deepEqual(directoryRevealPaths(files, PRIMARY, `${NESTED}/Runtime/`), [NESTED, `${NESTED}/Runtime`]);
});

test('drive letters compare case-insensitively', () => {
  assert.deepEqual(directoryRevealPaths(files, PRIMARY, 'c:/unity/changefiedpackages/Assets'), [
    PACKAGES,
    `${PACKAGES}/Assets`,
  ]);
});

test('a path outside every folder expands nothing', () => {
  assert.deepEqual(directoryRevealPaths(files, PRIMARY, 'C:/Unity/Elsewhere/src'), []);
});

test('folder nodes start expanded, can be collapsed, and collapse-all keeps them open', () => {
  const { result } = renderHook(() => useExpandedDirectories([PRIMARY, PACKAGES]));

  assert.equal(result.current.expandedDirs.has(PRIMARY), true);
  assert.equal(result.current.expandedDirs.has(PACKAGES), true);

  act(() => result.current.toggleDirectory(PACKAGES));
  assert.equal(result.current.expandedDirs.has(PACKAGES), false);

  act(() => result.current.toggleDirectory(`${PRIMARY}/Assets`));
  assert.equal(result.current.expandedDirs.has(`${PRIMARY}/Assets`), true);

  act(() => result.current.collapseAll());
  assert.equal(result.current.expandedDirs.has(`${PRIMARY}/Assets`), false);
  assert.equal(result.current.expandedDirs.has(PACKAGES), true);
});
