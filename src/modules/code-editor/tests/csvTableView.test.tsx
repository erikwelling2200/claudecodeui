import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'name;city\r\n"Ann";Utrecht\r\nBob;Delft\r\n' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value }: { value: string }) {
    return <textarea data-testid="editor" value={value} readOnly />;
  }
  return { default: CodeMirrorStub };
});

globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
};

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const file: CodeEditorFile = { name: 'people.csv', path: '/repo/people.csv', projectId: 'p1' };

const cell = (text: string) => screen.getByText(text).closest('td, th') as HTMLElement;

test('a CSV file opens as a table and a cell edit is saved as one changed line', async () => {
  render(<CodeEditor file={file} onClose={() => undefined} />);
  await screen.findByText('Utrecht');
  const table = screen.getByTestId('csv-table');

  // The header row is drawn once, as column titles.
  assert.equal(screen.getAllByText('name').length, 1);

  fireEvent.mouseDown(cell('Delft'));
  fireEvent.keyDown(table, { key: 'R' });
  const input = await screen.findByDisplayValue('R');
  fireEvent.change(input, { target: { value: 'Rotterdam; Zuid' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal((saveFile.mock.calls[0] as unknown[])[2], 'name;city\r\n"Ann";Utrecht\r\nBob;"Rotterdam; Zuid"\r\n');

  // Undo returns the buffer to the file's text, so it is clean again.
  fireEvent.keyDown(table, { key: 'z', ctrlKey: true });
  await screen.findByText('Delft');
});

test('Escape abandons a cell edit and the text view shows the same buffer', async () => {
  render(<CodeEditor file={file} onClose={() => undefined} />);
  await screen.findByText('Utrecht');

  fireEvent.doubleClick(cell('Utrecht'));
  const input = await screen.findByDisplayValue('Utrecht');
  fireEvent.change(input, { target: { value: 'Leiden' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  await screen.findByText('Utrecht');
  assert.equal(screen.queryByLabelText('Unsaved changes'), null);

  fireEvent.click(screen.getByTitle('Show as text'));
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  // Like CodeMirror, a textarea reports the document with LF line endings.
  assert.equal(editor.value, 'name;city\n"Ann";Utrecht\nBob;Delft\n');
});
