import assert from 'node:assert/strict';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';

/**
 * The open editor follows the file on disk: a clean buffer reloads by itself, a dirty one asks whether to keep the
 * editor's text or the file's, and the editor's own save never counts as an outside change.
 */

const disk = { content: 'hello', modifiedAt: 1 };
const writeDisk = (content: string) => {
  disk.content = content;
  disk.modifiedAt += 1;
};

const readFile = vi.fn(async () => ({ json: async () => ({ content: disk.content, modifiedAt: disk.modifiedAt }) }));
const statFile = vi.fn(async () => ({ json: async () => ({ modifiedAt: disk.modifiedAt, size: disk.content.length }) }));
const saveFile = vi.fn(async (_projectId: string, _filePath: string, content: string) => {
  writeDisk(content);
  return { ok: true, json: async () => ({ success: true }) };
});

vi.mock('@/shared/api', () => ({
  api: { readFile, statFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => {
  function CodeMirrorStub({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
    return <textarea data-testid="editor" value={value} onChange={(event) => onChange?.(event.target.value)} />;
  }

  return { default: CodeMirrorStub };
});

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

globalThis.ResizeObserver ??= class {
  observe() {}

  unobserve() {}

  disconnect() {}
} as unknown as typeof ResizeObserver;

const file: CodeEditorFile = { name: 'a.txt', path: '/repo/a.txt', projectId: 'p1' };

beforeEach(() => {
  disk.content = 'hello';
  disk.modifiedAt = 1;
  vi.clearAllMocks();
});

const renderEditor = async () => {
  const dirtyReports: boolean[] = [];
  render(<CodeEditor file={file} onUnsavedChangesChange={(dirty) => dirtyReports.push(dirty)} />);
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  await waitFor(() => assert.equal(editor.value, 'hello'));
  return { editor, isDirty: () => dirtyReports.at(-1) === true };
};

// The window regaining focus checks the disk at once, so no test waits out the poll interval.
const checkDisk = async () => {
  const stats = statFile.mock.calls.length;
  await act(async () => {
    fireEvent.focus(window);
  });
  await waitFor(() => assert.ok(statFile.mock.calls.length > stats));
};

test('a clean buffer takes the new file content without asking', async () => {
  const { editor, isDirty } = await renderEditor();

  writeDisk('changed outside');
  await checkDisk();

  await waitFor(() => assert.equal(editor.value, 'changed outside'));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(isDirty(), false);
});

test('an unchanged mtime does not read the file again', async () => {
  await renderEditor();
  const reads = readFile.mock.calls.length;

  await checkDisk();

  assert.equal(readFile.mock.calls.length, reads);
});

test('a dirty buffer asks, and keeping the file replaces the edits', async () => {
  const { editor, isDirty } = await renderEditor();
  fireEvent.change(editor, { target: { value: 'my edit' } });

  writeDisk('changed outside');
  await checkDisk();

  await screen.findByRole('dialog');
  assert.equal(editor.value, 'my edit');
  fireEvent.click(screen.getByRole('button', { name: 'Keep file content' }));

  await waitFor(() => assert.equal(editor.value, 'changed outside'));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(isDirty(), false);
});

test('keeping the editor leaves the edits unsaved, and saving then overwrites the file', async () => {
  const { editor, isDirty } = await renderEditor();
  fireEvent.change(editor, { target: { value: 'my edit' } });

  writeDisk('changed outside');
  await checkDisk();
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editor content' }));

  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  assert.equal(editor.value, 'my edit');
  assert.equal(isDirty(), true);

  // No second prompt for the same change.
  await checkDisk();
  assert.equal(screen.queryByRole('dialog'), null);

  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(disk.content, 'my edit'));
  await waitFor(() => assert.equal(isDirty(), false));
});

test('the editor\'s own save, followed by more typing, is not taken for an outside change', async () => {
  const { editor, isDirty } = await renderEditor();
  fireEvent.change(editor, { target: { value: 'saved text' } });
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(disk.content, 'saved text'));
  await waitFor(() => assert.equal(isDirty(), false));

  fireEvent.change(editor, { target: { value: 'saved text, then more' } });
  await checkDisk();

  await waitFor(() => assert.ok(readFile.mock.calls.length >= 2));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(editor.value, 'saved text, then more');
  assert.equal(isDirty(), true);
});

test('an outside change that matches the edits clears the dirty state without asking', async () => {
  const { editor, isDirty } = await renderEditor();
  fireEvent.change(editor, { target: { value: 'same text' } });

  writeDisk('same text');
  await checkDisk();

  await waitFor(() => assert.equal(isDirty(), false));
  assert.equal(screen.queryByRole('dialog'), null);
});
