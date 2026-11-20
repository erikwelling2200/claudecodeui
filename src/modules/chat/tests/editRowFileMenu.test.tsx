import assert from 'node:assert/strict';

import { fireEvent, render } from '@testing-library/react';
import { test, vi } from 'vitest';

import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({
    openFileInEditor: vi.fn(),
    openDirectory: vi.fn(),
    resolveFilePath: vi.fn(async (path: string) => path),
    revealFile: vi.fn(async () => undefined),
  }),
}));

const editInput = { file_path: 'C:/repo/src/app.ts', old_string: 'a', new_string: 'b' };

const renderEditRow = (onFileOpen: (filePath: string, diffInfo?: unknown) => void) => render(
  <ToolRenderer
    toolName="Edit"
    toolInput={editInput}
    toolResult={{ content: 'ok', isError: false }}
    mode="input"
    onFileOpen={onFileOpen}
    createDiff={() => []}
  />,
);

type Queries = ReturnType<typeof renderEditRow>;

// The diff header names the file too; the title is the first button that does.
const openMenu = ({ getAllByRole }: Queries) => {
  const title = getAllByRole('button', { name: /app\.ts/ })[0];
  const notPrevented = fireEvent.contextMenu(title, { clientX: 10, clientY: 10 });
  assert.equal(notPrevented, false);
};

test('right-clicking the file of an Edit row offers the diff and the file', () => {
  const row = renderEditRow(vi.fn());
  openMenu(row);
  const items = [...row.getByRole('menu').querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
  assert.deepEqual(items, ['Open diff', 'Open file', 'Show in Explorer', 'Copy path']);
});

test('Open diff opens the change, Open file opens the plain file', () => {
  const onFileOpen = vi.fn();
  const row = renderEditRow(onFileOpen);
  openMenu(row);
  fireEvent.click(row.getByText('Open diff'));
  openMenu(row);
  fireEvent.click(row.getByText('Open file'));
  assert.deepEqual(onFileOpen.mock.calls, [
    ['C:/repo/src/app.ts', { old_string: 'a', new_string: 'b' }],
    ['C:/repo/src/app.ts'],
  ]);
});
