import assert from 'node:assert/strict';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { CodeEditorFile } from '@/shared/types';
import { buildSearchPattern, expandReplacement, findTextMatches, getFileAccess } from '@/modules/code-editor/utils/fileSearch';
import type { FileSearchQuery } from '@/modules/code-editor/utils/fileSearch';
import { createCodeMirrorSearchProvider, fileFindExtension } from '@/modules/code-editor/utils/codeMirrorSearch';
import { createDomTextSearchProvider } from '@/modules/code-editor/utils/domTextSearch';

const readFile = vi.fn(async () => ({ ok: true, json: async () => ({ content: 'name;city\r\nAnn;Delft\r\nBob;Delft\r\n' }) }));
const saveFile = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));

vi.mock('@/shared/api', () => ({
  api: { readFile, saveFile },
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

globalThis.ResizeObserver = class {
  observe() {}

  unobserve() {}

  disconnect() {}
};

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');
const { default: CodeEditorFrame } = await import('@/modules/code-editor/CodeEditorFrame');

const query = (text: string, options: Partial<FileSearchQuery> = {}): FileSearchQuery => ({ text, matchCase: false, wholeWord: false, regex: false, ...options });

test('the file type decides access: previews and binaries are read-only, text is read-write', () => {
  for (const name of ['manual.pdf', 'logo.png', 'clip.mp4', 'song.mp3', 'bundle.zip']) assert.equal(getFileAccess(name), 'read-only', name);
  for (const name of ['index.ts', 'README.md', 'people.csv', 'Makefile']) assert.equal(getFileAccess(name), 'read-write', name);
});

test('the pattern follows match case, whole word and regex, and an invalid regex finds nothing', () => {
  const text = 'Foo food foo';
  assert.equal(findTextMatches(text, buildSearchPattern(query('foo'))!).length, 3);
  assert.equal(findTextMatches(text, buildSearchPattern(query('foo', { matchCase: true }))!).length, 2);
  assert.equal(findTextMatches(text, buildSearchPattern(query('foo', { wholeWord: true }))!).length, 2);
  assert.equal(findTextMatches(text, buildSearchPattern(query('fo+d', { regex: true }))!).length, 1);
  assert.equal(findTextMatches('a.b axb', buildSearchPattern(query('a.b'))!).length, 1);
  assert.equal(buildSearchPattern(query('(', { regex: true })), null);
  assert.equal(expandReplacement('key=value', query('(\\w+)=(\\w+)', { regex: true }), '$2=$1'), 'value=key');
  assert.equal(expandReplacement('key=value', query('key=value'), '$2'), '$2');
});

test('the text editor provider counts the whole document, selects a hit and replaces', () => {
  const view = new EditorView({ state: EditorState.create({ doc: 'foo bar foo\nFoo', extensions: [fileFindExtension] }), parent: document.body });
  const provider = createCodeMirrorSearchProvider(view);

  assert.equal(provider.search(query('foo')), 3);
  provider.reveal(1, true);
  assert.deepEqual([view.state.selection.main.from, view.state.selection.main.to], [8, 11]);
  assert.equal(view.dom.querySelectorAll('.cm-file-find-current').length, 1);

  provider.replace!(1, 'baz');
  assert.equal(view.state.doc.toString(), 'foo bar baz\nFoo');

  assert.equal(provider.search(query('foo', { matchCase: true })), 1);
  provider.replaceAll!('qux');
  assert.equal(view.state.doc.toString(), 'qux bar baz\nFoo');
  view.destroy();
});

test('rendered-text search counts what a view shows', () => {
  const root = document.createElement('div');
  root.innerHTML = '<h1>Release notes</h1><p>The release is <b>out</b>; release day.</p>';
  const provider = createDomTextSearchProvider(root);
  assert.equal(provider.search(query('release')), 3);
  assert.equal(provider.search(query('Release', { matchCase: true })), 1);
  provider.clear();
});

test('a read-only file gets find without replace', async () => {
  const pdf: CodeEditorFile = { name: 'manual.pdf', path: '/repo/manual.pdf', projectId: 'p1' };
  render(
    <CodeEditorFrame file={pdf} tabStrip={null} isSidebar isExpanded={false} isFullscreen={false} onToggleExpand={null} onPopOut={null} onToggleFullscreen={() => undefined}>
      <p data-testid="page">Chapter one of the manual</p>
    </CodeEditorFrame>,
  );

  fireEvent.keyDown(screen.getByTestId('page'), { key: 'f', ctrlKey: true });
  await screen.findByRole('search');
  assert.ok(screen.getByLabelText('Read-only'));
  assert.equal(screen.queryByTitle('Toggle replace (Ctrl+H)'), null);

  fireEvent.keyDown(screen.getByTestId('page'), { key: 'h', ctrlKey: true });
  assert.equal(screen.queryByPlaceholderText('Replace'), null);
});

test('in a CSV table, find marks the cells and replace all edits the buffer', async () => {
  const file: CodeEditorFile = { name: 'people.csv', path: '/repo/people.csv', projectId: 'p1' };
  render(<CodeEditor file={file} />);
  await screen.findAllByText('Delft');

  fireEvent.keyDown(screen.getByTestId('csv-table'), { key: 'h', ctrlKey: true });
  fireEvent.change(await screen.findByPlaceholderText('Find'), { target: { value: 'delft' } });
  await waitFor(() => assert.ok(screen.getAllByText('Delft').every((cell) => /bg-(yellow|orange)/.test(cell.closest('td')!.className))));

  fireEvent.change(screen.getByPlaceholderText('Replace'), { target: { value: 'Leiden' } });
  fireEvent.click(screen.getByTitle('Replace all (Ctrl+Enter)'));
  await waitFor(() => assert.equal(screen.getAllByText('Leiden').length, 2));

  fireEvent.keyDown(document, { key: 's', ctrlKey: true });
  await waitFor(() => assert.equal(saveFile.mock.calls.length, 1));
  assert.equal((saveFile.mock.calls[0] as unknown[])[2], 'name;city\r\nAnn;Leiden\r\nBob;Leiden\r\n');
});
