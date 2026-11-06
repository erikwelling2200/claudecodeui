import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { FileSearchResult, Project } from '@/shared/types';

/**
 * The `@` dropdown asks the server's file index for each query, so a file added
 * after the composer opened (an upload, an agent edit) is offered without a
 * reload, and only the answer to the latest query is ever shown.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const result = (name: string): FileSearchResult => ({
  name,
  path: `${ROOT}/${name}`,
  relativePath: name,
  type: 'file',
  rootPath: ROOT,
  rootIndex: 0,
});
const searchResponse = (names: string[]) => ({ ok: true, json: async () => ({ results: names.map(result) }) });

// A search response the test resolves by hand, to hold a request in flight.
const deferredSearchResponse = () => {
  let resolve: (names: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof searchResponse>>((resolvePromise) => {
    resolve = (names) => resolvePromise(searchResponse(names));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

test('nothing is fetched until `@` is typed, then the query goes to the server', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue(searchResponse(['uploaded.txt']));

  const { type, shownNames } = renderMentions();
  type('hello');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(searchFiles.mock.calls.length, 0);

  type('hello @upl');

  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
  assert.equal(searchFiles.mock.calls.at(-1)?.[1], 'upl');
});

test('fast typing sends one search for the query the typing stopped at', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue(searchResponse(['a.txt']));

  const { type, shownNames } = renderMentions();
  type('@a');
  type('@a.');
  type('@a.t');

  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.deepEqual(searchFiles.mock.calls.map((call) => call[1]), ['a.t']);
});

test('an older search that lands after a newer query cannot overwrite its results', async () => {
  searchFiles.mockReset();
  const older = deferredSearchResponse();
  const newer = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(older.promise);
  searchFiles.mockReturnValueOnce(newer.promise);

  const { type, shownNames } = renderMentions();
  type('@o');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@ne');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  const olderSignal = (searchFiles.mock.calls[0][3] as { signal: AbortSignal }).signal;
  assert.equal(olderSignal.aborted, true);

  await act(async () => {
    newer.resolve(['newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['newer.txt']));

  await act(async () => {
    older.resolve(['older.txt']);
  });
  assert.deepEqual(shownNames(), ['newer.txt']);
});

test('a search that lands after Escape dismissed the dropdown does not re-open it', async () => {
  searchFiles.mockReset();
  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);

  const { result, type } = renderMentions();
  type('mail me at foo@');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.equal(result.current.showFileDropdown, true);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });

  await act(async () => {
    pending.resolve(['a.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  // Still dismissed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
});
