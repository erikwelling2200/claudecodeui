import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * In a multi-folder project the agent's working directory is the primary
 * folder: its files are mentioned by relative path as before, while files of
 * the other folders are mentioned by absolute path so the agent can find them.
 */

const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { getFiles: (...args: unknown[]) => getFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const PRIMARY = '/work/app';
const EXTRA = '/work/shared-lib';
const project: Project = { projectId: 'p1', displayName: 'app', fullPath: PRIMARY, additionalFolders: [EXTRA] };

const tree = [
  {
    type: 'directory',
    name: 'app',
    path: PRIMARY,
    isProjectRoot: true,
    children: [
      {
        type: 'directory',
        name: 'src',
        path: `${PRIMARY}/src`,
        children: [{ type: 'file', name: 'main.ts', path: `${PRIMARY}/src/main.ts` }],
      },
    ],
  },
  {
    type: 'directory',
    name: 'shared-lib',
    path: EXTRA,
    isProjectRoot: true,
    children: [
      {
        type: 'directory',
        name: 'lib',
        path: `${EXTRA}/lib`,
        children: [{ type: 'file', name: 'util.ts', path: `${EXTRA}/lib/util.ts` }],
      },
    ],
  },
];

test('primary-folder files keep relative paths and extra-folder files use absolute paths', async () => {
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });

  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );
  await waitFor(() => assert.equal(getFiles.mock.calls.length, 1));

  hook.rerender({ input: '@.ts' });
  act(() => {
    hook.result.current.setCursorPosition('@.ts'.length);
  });

  await waitFor(() => assert.deepEqual(
    hook.result.current.filteredFiles.map((file) => file.path).sort(),
    [`${EXTRA}/lib/util.ts`, 'src/main.ts'],
  ));
});
