import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import { test, vi } from 'vitest';

import type { FileSearchResult, Project } from '@/shared/types';

/**
 * In a multi-folder project the agent's working directory is the primary
 * folder: its files are mentioned by relative path as before, while files of
 * the other folders are mentioned by absolute path so the agent can find them.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const PRIMARY = '/work/app';
const EXTRA = '/work/shared-lib';
const project: Project = { projectId: 'p1', displayName: 'app', fullPath: PRIMARY, additionalFolders: [EXTRA] };

const results: FileSearchResult[] = [
  { name: 'main.ts', path: `${PRIMARY}/src/main.ts`, relativePath: 'src/main.ts', type: 'file', rootPath: PRIMARY, rootIndex: 0 },
  { name: 'util.ts', path: `${EXTRA}/lib/util.ts`, relativePath: 'lib/util.ts', type: 'file', rootPath: EXTRA, rootIndex: 1 },
];

test('primary-folder files keep relative paths and extra-folder files use absolute paths', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue({ ok: true, json: async () => ({ results }) });

  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  hook.rerender({ input: '@.ts' });
  act(() => {
    hook.result.current.setCursorPosition('@.ts'.length);
  });

  await waitFor(() => assert.deepEqual(
    hook.result.current.filteredFiles.map((file) => file.path).sort(),
    [`${EXTRA}/lib/util.ts`, 'src/main.ts'],
  ));
});
