import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { GitTarget, Project } from '@/shared/types';

/**
 * A multi-folder project gets a folder switcher in the git panel. Every git
 * request carries the chosen folder (and none for the primary, so
 * single-folder requests are unchanged), and the worktrees tab, which belongs
 * to the primary repository, disappears for the other folders.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/shared/hooks/useSelectedProvider', () => ({
  useSelectedProvider: () => 'claude',
}));

const statusCalls: GitTarget[] = [];

const jsonResponse = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });

vi.mock('@/shared/api', () => ({
  api: {
    git: {
      status: (target: GitTarget) => {
        statusCalls.push(target);
        return jsonResponse({ branch: 'main', modified: [], added: [], deleted: [], untracked: [] });
      },
      branches: () => jsonResponse({ branches: ['main'], localBranches: ['main'], remoteBranches: [], remoteRefs: [] }),
      remoteStatus: () => jsonResponse({ hasRemote: false }),
      diff: () => jsonResponse({}),
      commits: () => jsonResponse({ commits: [] }),
    },
    worktrees: {
      list: () => jsonResponse({ worktrees: [] }),
    },
  },
}));

const { default: GitPanel } = await import('@/modules/git-panel/GitPanel');

const PRIMARY = '/work/app';
const EXTRA = '/work/shared-lib';

const multiFolderProject: Project = {
  projectId: 'p1',
  displayName: 'app',
  fullPath: PRIMARY,
  path: PRIMARY,
  additionalFolders: [EXTRA],
};

beforeEach(() => {
  statusCalls.length = 0;
});

test('switching folders sends that folder with every git request and hides worktrees', async () => {
  render(<GitPanel selectedProject={multiFolderProject} />);

  await waitFor(() => assert.ok(statusCalls.length > 0));
  assert.deepEqual(statusCalls[0], { projectId: 'p1', folder: null });
  assert.ok(screen.getByRole('tab', { name: /git:tabs.worktrees/ }));

  const select = screen.getByLabelText('git:header.folder') as HTMLSelectElement;
  assert.deepEqual(Array.from(select.options).map((option) => option.value), [PRIMARY, EXTRA]);

  fireEvent.change(select, { target: { value: EXTRA } });

  await waitFor(() => assert.deepEqual(statusCalls.at(-1), { projectId: 'p1', folder: EXTRA }));
  assert.equal(screen.queryByRole('tab', { name: /git:tabs.worktrees/ }), null);
});

test('a single-folder project shows no folder switcher', async () => {
  render(<GitPanel selectedProject={{ ...multiFolderProject, additionalFolders: [] }} />);

  await waitFor(() => assert.ok(statusCalls.length > 0));
  assert.equal(screen.queryByLabelText('git:header.folder'), null);
  assert.deepEqual(statusCalls[0], { projectId: 'p1', folder: null });
});
