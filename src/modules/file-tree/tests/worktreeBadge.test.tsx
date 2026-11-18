import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import '@/modules/i18n';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';
import type { FileTreeNode as FileTreeNodeType } from '@/shared/types';

/**
 * A project-root row of a chat parked in a worktree carries a badge naming
 * that worktree, so the user can tell `ChangefiedPackages` listed from
 * `ChangefiedPackages-alt` apart from the main checkout.
 */

const rootNode = (worktree: FileTreeNodeType['worktree']): FileTreeNodeType => ({
  name: 'ChangefiedPackages',
  type: 'directory',
  path: 'C:/Unity/ChangefiedPackages-alt',
  isProjectRoot: true,
  children: [],
  worktree,
});

const renderNode = (item: FileTreeNodeType) => render(
  <FileTreeNode
    item={item}
    level={0}
    viewMode="simple"
    expandedDirs={new Set()}
    onItemClick={() => undefined}
    renderFileIcon={() => null}
    formatFileSize={() => ''}
    formatRelativeTime={() => ''}
  />,
);

test('a worktree root is badged with its suffix and branch', () => {
  renderNode(rootNode({ suffix: 'alt', branch: 'feature', mainPath: 'C:/Unity/ChangefiedPackages' }));
  assert.ok(screen.getByText('ChangefiedPackages'));
  assert.ok(screen.getByText('alt'));
  assert.ok(screen.getByText('· feature'));
});

test('a missing worktree says the main checkout is shown instead', () => {
  renderNode(rootNode({ suffix: 'alt', branch: null, mainPath: 'C:/Unity/ChangefiedPackages', missing: true }));
  const badge = screen.getByText('main');
  assert.match(badge.getAttribute('title') ?? '', /"alt" worktree of this folder does not exist/);
});

test('a plain root has no badge', () => {
  renderNode(rootNode(undefined));
  assert.equal(screen.queryByText('alt'), null);
  assert.equal(screen.queryByText('main'), null);
});
