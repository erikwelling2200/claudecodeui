import assert from 'node:assert/strict';

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { Markdown } from '@/modules/chat/transcript/Markdown';
import type * as SharedUtils from '@/shared/utils';

const { openFileInEditor, openDirectory, resolveFilePath, revealFile, copyTextToClipboard } = vi.hoisted(() => ({
  openFileInEditor: vi.fn(),
  openDirectory: vi.fn(),
  resolveFilePath: vi.fn(async (path: string) => `C:/Tools/project/${path}`),
  revealFile: vi.fn(async (_path: string) => undefined),
  copyTextToClipboard: vi.fn(async (_text: string) => true),
}));

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory, resolveFilePath, revealFile }),
}));

vi.mock('@/shared/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedUtils>()),
  copyTextToClipboard,
}));

beforeEach(() => {
  for (const mock of [openFileInEditor, openDirectory, resolveFilePath, revealFile, copyTextToClipboard]) {
    mock.mockClear();
  }
});

test('right-clicking a file reference opens the file menu instead of the browser menu', () => {
  const { getByRole, queryByRole } = render(<Markdown>{'See `src/app.ts:12`.'}</Markdown>);
  assert.equal(queryByRole('menu'), null);
  const notPrevented = fireEvent.contextMenu(getByRole('link'), { clientX: 10, clientY: 10 });
  assert.equal(notPrevented, false);
  const items = [...getByRole('menu').querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  assert.deepEqual(items, ['Open', 'Show in Explorer', 'Copy path']);
});

test('Open opens the file at its line, like a click', () => {
  const { getByRole, getByText } = render(<Markdown>{'See `src/app.ts:12`.'}</Markdown>);
  fireEvent.contextMenu(getByRole('link'));
  fireEvent.click(getByText('Open'));
  assert.deepEqual(openFileInEditor.mock.calls, [['src/app.ts', 12]]);
});

test('Copy path copies the resolved full path without the line suffix', async () => {
  const { getByRole, getByText } = render(<Markdown>{'See `src/app.ts:12`.'}</Markdown>);
  fireEvent.contextMenu(getByRole('link'));
  fireEvent.click(getByText('Copy path'));
  await waitFor(() => getByText('Path copied'));
  assert.deepEqual(resolveFilePath.mock.calls, [['src/app.ts']]);
  assert.deepEqual(copyTextToClipboard.mock.calls, [['C:/Tools/project/src/app.ts']]);
});

test('Show in Explorer reveals the decoded path of a markdown link', async () => {
  const { getByRole, getByText } = render(<Markdown>{'[notes](<docs/My%20Notes.md>)'}</Markdown>);
  fireEvent.contextMenu(getByRole('link'));
  fireEvent.click(getByText('Show in Explorer'));
  await waitFor(() => assert.equal(revealFile.mock.calls.length, 1));
  assert.deepEqual(revealFile.mock.calls, [['docs/My Notes.md']]);
});

test('a failed reveal says so and offers a retry', async () => {
  revealFile.mockRejectedValueOnce(new Error('HTTP 404'));
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { getByRole, getByText } = render(<Markdown>{'See `src/gone.ts`.'}</Markdown>);
  fireEvent.contextMenu(getByRole('link'));
  fireEvent.click(getByText('Show in Explorer'));
  await waitFor(() => getByText('Could not show in Explorer'));
  errorSpy.mockRestore();
});
