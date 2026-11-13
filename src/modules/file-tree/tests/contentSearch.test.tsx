import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { FileContentMatch, FileTreeNode, Project } from '@/shared/types';

/**
 * The content search end to end on the client: the header's switch and folder
 * choices decide the request, streamed matches become rows, and a row opens
 * the file at its line. The server is replaced by a hand-driven EventSource.
 */

const ALPHA = '/work/alpha';
const BETA = '/work/beta';

let tree: FileTreeNode[] = [];
const searchRequests: unknown[][] = [];

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: async () => ({ ok: true, json: async () => tree }),
    getFileChildren: async () => ({ ok: true, json: async () => ({}) }),
    searchFileContentsUrl: (...request: unknown[]) => {
      searchRequests.push(request);
      return '/search-content';
    },
  },
}));

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(eventName: string, listener: (event: unknown) => void) {
    this.listeners.set(eventName, [...(this.listeners.get(eventName) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  send(eventName: string, data?: unknown) {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(data === undefined ? {} : { data: JSON.stringify(data) });
    }
  }
}

const { default: FileTree } = await import('@/modules/file-tree/FileTree');
const { appendContentMatches, parseContentSearchGlobs } = await import('@/modules/file-tree/hooks/useFileContentSearch');

const project: Project = { projectId: 'p1', displayName: 'work', fullPath: ALPHA, path: ALPHA };

const multiFolderTree: FileTreeNode[] = [
  { type: 'directory', name: 'alpha', path: ALPHA, isProjectRoot: true, children: [] },
  { type: 'directory', name: 'beta', path: BETA, isProjectRoot: true, children: [] },
];

function createMatch(overrides: Partial<FileContentMatch> = {}): FileContentMatch {
  return {
    path: `${ALPHA}/src/main.ts`,
    relativePath: 'src/main.ts',
    rootPath: ALPHA,
    rootIndex: 0,
    line: 12,
    character: 6,
    snippet: 'const needle = 1;',
    highlights: [{ start: 6, end: 12 }],
    ...overrides,
  };
}

async function searchContentsFor(query: string): Promise<FakeEventSource> {
  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: query } });
  await waitFor(() => assert.equal(FakeEventSource.opened.length, 1));
  return FakeEventSource.opened[0];
}

beforeEach(() => {
  tree = multiFolderTree;
  searchRequests.length = 0;
  FakeEventSource.opened = [];
  localStorage.clear();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('a streamed match is listed under its file and opens that file at its line', async () => {
  const onFileOpen = vi.fn();
  render(<FileTree selectedProject={project} onFileOpen={onFileOpen} />);

  const source = await searchContentsFor('needle');
  assert.deepEqual(searchRequests, [['p1', 'needle', { regex: false, globs: [], rootIndexes: undefined }]]);

  source.send('matches', { matches: [createMatch(), createMatch({ line: 30, character: 0, snippet: 'needle()', highlights: [{ start: 0, end: 6 }] })] });
  source.send('done', { truncated: false });

  await waitFor(() => assert.ok(screen.getByText('main.ts')));
  // The project folder's name leads the path, because two folders can hold the same relative path.
  assert.ok(screen.getByText('alpha/src'));
  assert.equal(source.closed, true);

  fireEvent.click(screen.getByText('30'));
  assert.deepEqual(onFileOpen.mock.calls, [[`${ALPHA}/src/main.ts`, null, 30, 0]]);
});

test('a folder switched off is left out of the request and stays off for the next visit', async () => {
  const { unmount } = render(<FileTree selectedProject={project} />);

  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  const betaChip = screen.getByRole('button', { name: 'beta' });
  assert.equal(betaChip.getAttribute('aria-pressed'), 'true');
  fireEvent.click(betaChip);
  assert.equal(betaChip.getAttribute('aria-pressed'), 'false');

  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'needle' } });
  await waitFor(() => assert.equal(searchRequests.length, 1));
  assert.deepEqual(searchRequests[0][2], { regex: false, globs: [], rootIndexes: [0] });

  unmount();
  render(<FileTree selectedProject={project} />);
  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  assert.equal(screen.getByRole('button', { name: 'beta' }).getAttribute('aria-pressed'), 'false');
});

test('ctrl+click searches only that folder, and ctrl+click on the lone folder searches every folder again', async () => {
  tree = [...multiFolderTree, { type: 'directory', name: 'gamma', path: '/work/gamma', isProjectRoot: true, children: [] }];
  render(<FileTree selectedProject={project} />);

  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  const pressedChips = () => ['alpha', 'beta', 'gamma'].map((name) => screen.getByRole('button', { name }).getAttribute('aria-pressed'));
  // beta starts switched off: the solo switches it on as well as switching the others off.
  fireEvent.click(screen.getByRole('button', { name: 'beta' }));
  fireEvent.click(screen.getByRole('button', { name: 'beta' }), { ctrlKey: true });
  assert.deepEqual(pressedChips(), ['false', 'true', 'false']);

  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'needle' } });
  await waitFor(() => assert.equal(searchRequests.length, 1));
  assert.deepEqual(searchRequests[0][2], { regex: false, globs: [], rootIndexes: [1] });

  fireEvent.click(screen.getByRole('button', { name: 'beta' }), { metaKey: true });
  assert.deepEqual(pressedChips(), ['true', 'true', 'true']);
});

test('with every folder switched off nothing is searched', async () => {
  render(<FileTree selectedProject={project} />);

  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  fireEvent.click(screen.getByRole('button', { name: 'alpha' }));
  fireEvent.click(screen.getByRole('button', { name: 'beta' }));
  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'needle' } });

  await waitFor(() => assert.ok(screen.getByText('fileTree.noMatchesFound')));
  assert.equal(FakeEventSource.opened.length, 0);
});

test('a single-folder project offers no folder choice and searches everything', async () => {
  tree = [{ type: 'file', name: 'readme.md', path: `${ALPHA}/readme.md` }];
  render(<FileTree selectedProject={project} />);

  await searchContentsFor('needle');

  assert.equal(screen.queryByRole('group'), null);
  assert.deepEqual(searchRequests, [['p1', 'needle', { regex: false, globs: [], rootIndexes: undefined }]]);
});

test('the file filter and the regex switch are part of the request', async () => {
  render(<FileTree selectedProject={project} />);

  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  fireEvent.click(screen.getByTitle('fileTree.contentSearchRegex'));
  fireEvent.change(screen.getByTitle('fileTree.contentSearchFilter'), { target: { value: '*.{cs,ts}, !*.meta' } });
  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'a|b' } });

  await waitFor(() => assert.equal(searchRequests.length, 1));
  assert.deepEqual(searchRequests[0], ['p1', 'a|b', { regex: true, globs: ['*.{cs,ts}', '!*.meta'], rootIndexes: undefined }]);
});

test('typing on closes the running search and starts the next one', async () => {
  render(<FileTree selectedProject={project} />);

  const first = await searchContentsFor('needle');
  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'needles' } });

  await waitFor(() => assert.equal(FakeEventSource.opened.length, 2));
  assert.equal(first.closed, true);
});

test('the server\'s explanation of a rejected pattern is shown, and the connection is not retried', async () => {
  render(<FileTree selectedProject={project} />);

  const source = await searchContentsFor('a(');
  source.send('error', { error: 'unclosed group' });

  await waitFor(() => assert.ok(screen.getByText('unclosed group')));
  assert.equal(source.closed, true);
});

test('a query too short to search for leaves the tree on screen', async () => {
  render(<FileTree selectedProject={project} />);

  fireEvent.click(await screen.findByTitle('fileTree.searchInContents'));
  fireEvent.change(screen.getByPlaceholderText('fileTree.contentSearchPlaceholder'), { target: { value: 'n' } });

  // Longer than the debounce, so a search would have started by now.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(FakeEventSource.opened.length, 0);
  assert.equal(screen.getAllByText('alpha').length, 2);
});

test('the filter text splits on commas outside a brace group', () => {
  assert.deepEqual(parseContentSearchGlobs(' *.cs , !*.meta,,*.{ts,tsx} '), ['*.cs', '!*.meta', '*.{ts,tsx}']);
  assert.deepEqual(parseContentSearchGlobs(''), []);
});

test('new matches join their file\'s group, and untouched groups keep their identity', () => {
  const first = appendContentMatches([], [createMatch(), createMatch({ path: `${BETA}/b.ts`, relativePath: 'b.ts', rootIndex: 1 })]);
  const second = appendContentMatches(first, [createMatch({ line: 40 })]);

  assert.deepEqual(second.map((file) => [file.relativePath, file.matches.map((match) => match.line)]), [
    ['src/main.ts', [12, 40]],
    ['b.ts', [12]],
  ]);
  assert.equal(second[1], first[1]);
  // The earlier list is what React rendered from, so it is never changed in place.
  assert.equal(first[0].matches.length, 1);
});
