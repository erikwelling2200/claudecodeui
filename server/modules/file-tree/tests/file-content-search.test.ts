import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileContentSearch } from '@/modules/file-tree/file-content-search.js';
import { runRipgrepJson } from '@/modules/file-tree/file-content-search.adapters.js';
import type {
  FileContentMatch,
  FileContentSearchOptions,
  FileTreeContentSearchDependencies,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type FakeRun = { exitCode?: number; errorOutput?: string; lines?: string[] };

/** A ripgrep that prints prepared lines per folder and records how it was called. */
function createFakeRipgrep(runs: Record<string, FakeRun>) {
  const calls: Array<{ folderPath: string; args: string[] }> = [];
  const abortedFolders: string[] = [];
  const runRipgrep: FileTreeContentSearchDependencies['runRipgrep'] = async (folderPath, args, run) => {
    calls.push({ folderPath, args });
    run.signal.addEventListener('abort', () => abortedFolders.push(folderPath));
    const fakeRun = runs[folderPath] ?? {};
    // One line per batch, the way a slow search trickles in.
    for (const line of fakeRun.lines ?? []) {
      run.onLines([line]);
    }
    return { exitCode: fakeRun.exitCode ?? 0, errorOutput: fakeRun.errorOutput ?? '' };
  };
  return { runRipgrep, calls, abortedFolders };
}

function matchLine(filePath: string, lineNumber: number, text: string, needle: string): string {
  const submatches: Array<{ match: { text: string }; start: number; end: number }> = [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    const start = Buffer.byteLength(text.slice(0, from), 'utf8');
    submatches.push({ match: { text: needle }, start, end: start + Buffer.byteLength(needle, 'utf8') });
    from = text.indexOf(needle, from + needle.length);
  }
  return JSON.stringify({
    type: 'match',
    data: { path: { text: filePath }, lines: { text: `${text}\n` }, line_number: lineNumber, absolute_offset: 0, submatches },
  });
}

async function collect(
  runRipgrep: FileTreeContentSearchDependencies['runRipgrep'],
  folderPaths: string[],
  query: string,
  options: Partial<FileContentSearchOptions> = {},
  signal: AbortSignal = new AbortController().signal,
): Promise<{ matches: FileContentMatch[]; batches: number; truncated: boolean }> {
  const matches: FileContentMatch[] = [];
  let batches = 0;
  const { truncated } = await createFileContentSearch({ runRipgrep }).search(
    folderPaths,
    query,
    { regex: false, globs: [], limit: 100, ...options },
    {
      signal,
      onMatches: (batch) => {
        batches += 1;
        matches.push(...batch);
      },
    },
  );
  return { matches, batches, truncated };
}

const projectRoot = path.resolve('content-search-project');
const nestedRoot = path.join(projectRoot, 'packages', 'core');
const otherRoot = path.resolve('content-search-other');

test('a literal search passes the query as a fixed string after the option terminator', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  await collect(runRipgrep, [projectRoot], '--files (x');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].folderPath, projectRoot);
  assert.ok(calls[0].args.includes('--fixed-strings'));
  assert.deepEqual(calls[0].args.slice(-3), ['--', '--files (x', './']);
});

test('a regex search leaves out the fixed-string flag', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  await collect(runRipgrep, [projectRoot], 'a|b', { regex: true });

  assert.equal(calls[0].args.includes('--fixed-strings'), false);
});

test('the file filters come before the skipped and nested folders, which therefore win', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  await collect(runRipgrep, [projectRoot, nestedRoot], 'needle', { globs: ['*.cs', '!*.meta'] });

  const outerGlobs = calls[0].args.filter((_argument, index) => calls[0].args[index - 1] === '--glob');
  assert.deepEqual(outerGlobs, ['*.cs', '!*.meta', '!.git', '!node_modules', '!.svn', '!.hg', '!packages/core/**']);

  const nestedGlobs = calls[1].args.filter((_argument, index) => calls[1].args[index - 1] === '--glob');
  assert.deepEqual(nestedGlobs, ['*.cs', '!*.meta', '!.git', '!node_modules', '!.svn', '!.hg']);
});

test('only the chosen folders are searched, and a nested folder left out stays excluded from its parent', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  await collect(runRipgrep, [projectRoot, nestedRoot, otherRoot], 'needle', { rootIndexes: [2, 0, 0] });

  assert.deepEqual(calls.map((call) => call.folderPath), [projectRoot, otherRoot]);
  assert.ok(calls[0].args.includes('!packages/core/**'));
});

test('no chosen folder means no search', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  const { matches } = await collect(runRipgrep, [projectRoot], 'needle', { rootIndexes: [] });

  assert.deepEqual(calls, []);
  assert.deepEqual(matches, []);
});

test('a folder position outside the project is rejected', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});

  await assert.rejects(
    collect(runRipgrep, [projectRoot], 'needle', { rootIndexes: [1] }),
    (error) => error instanceof AppError && error.statusCode === 400,
  );
  assert.deepEqual(calls, []);
});

test('a match carries its folder, path, line and the ranges of every hit', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: {
      lines: [
        JSON.stringify({ type: 'begin', data: { path: { text: './src\\main.ts' } } }),
        matchLine('./src\\main.ts', 12, '    const needle = needle + 1;', 'needle'),
        JSON.stringify({ type: 'end', data: { path: { text: './src\\main.ts' } } }),
      ],
    },
    [otherRoot]: { lines: [matchLine('./readme.md', 1, 'needle', 'needle')] },
  });

  const { matches } = await collect(runRipgrep, [projectRoot, otherRoot], 'needle');

  assert.deepEqual(matches, [
    {
      path: path.join(projectRoot, 'src', 'main.ts'),
      relativePath: 'src/main.ts',
      rootPath: projectRoot,
      rootIndex: 0,
      line: 12,
      character: 10,
      // The indentation is dropped, so the ranges are those of the visible text.
      snippet: 'const needle = needle + 1;',
      highlights: [{ start: 6, end: 12 }, { start: 15, end: 21 }],
    },
    {
      path: path.join(otherRoot, 'readme.md'),
      relativePath: 'readme.md',
      rootPath: otherRoot,
      rootIndex: 1,
      line: 1,
      character: 0,
      snippet: 'needle',
      highlights: [{ start: 0, end: 6 }],
    },
  ]);
});

test('byte offsets become character offsets on a line with multi-byte characters', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: { lines: [matchLine('./a.txt', 1, 'héllo wörld 😀 needle', 'needle')] },
  });

  const { matches } = await collect(runRipgrep, [projectRoot], 'needle');

  assert.equal(matches[0].character, 'héllo wörld 😀 '.length);
  assert.deepEqual(matches[0].highlights, [{ start: 15, end: 21 }]);
  assert.equal(matches[0].snippet.slice(15, 21), 'needle');
});

test('a long line is cut to a window around its first match', async () => {
  const text = `${'a'.repeat(500)}needle${'b'.repeat(500)}needle`;
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: { lines: [matchLine('./bundle.min.js', 1, text, 'needle')] },
  });

  const { matches } = await collect(runRipgrep, [projectRoot], 'needle');
  const [match] = matches;

  assert.equal(match.character, 500);
  assert.equal(match.snippet.length, 202);
  assert.ok(match.snippet.startsWith('…') && match.snippet.endsWith('…'));
  // Only the hit inside the window is marked.
  assert.equal(match.highlights.length, 1);
  assert.equal(match.snippet.slice(match.highlights[0].start, match.highlights[0].end), 'needle');
});

test('lines that are not valid text, or not a match, are skipped', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: {
      lines: [
        JSON.stringify({ type: 'match', data: { path: { text: './a.bin' }, lines: { bytes: '/w==' }, line_number: 1, submatches: [] } }),
        '{"type":"match","data":{"path":{"text":"./cut-off',
        JSON.stringify({ type: 'summary', data: {} }),
        '',
      ],
    },
  });

  const { matches, batches } = await collect(runRipgrep, [projectRoot], 'needle');

  assert.deepEqual(matches, []);
  assert.equal(batches, 0);
});

test('the search stops every folder at the limit and reports that more was left', async () => {
  const { runRipgrep, abortedFolders } = createFakeRipgrep({
    [projectRoot]: {
      lines: [1, 2, 3, 4].map((lineNumber) => matchLine('./a.txt', lineNumber, 'needle', 'needle')),
    },
  });

  const { matches, truncated } = await collect(runRipgrep, [projectRoot], 'needle', { limit: 2 });

  assert.deepEqual(matches.map((match) => match.line), [1, 2]);
  assert.equal(truncated, true);
  assert.deepEqual(abortedFolders, [projectRoot]);
});

test('exactly as many matches as the limit is not reported as truncated', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: {
      lines: [1, 2].map((lineNumber) => matchLine('./a.txt', lineNumber, 'needle', 'needle')),
    },
  });

  const { matches, truncated } = await collect(runRipgrep, [projectRoot], 'needle', { limit: 2 });

  assert.equal(matches.length, 2);
  assert.equal(truncated, false);
});

test('a pattern ripgrep rejects fails the search with ripgrep\'s own explanation', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: { exitCode: 2, errorOutput: 'rg: regex parse error:\n    (?:a()\n    ^\nerror: unclosed group\n' },
  });

  await assert.rejects(
    collect(runRipgrep, [projectRoot], 'a(', { regex: true }),
    (error) => error instanceof AppError && error.statusCode === 400 && error.message === 'unclosed group',
  );
});

test('unreadable files, which exit with 2 and no message, do not fail the search', async () => {
  const { runRipgrep } = createFakeRipgrep({
    [projectRoot]: { exitCode: 2, lines: [matchLine('./a.txt', 1, 'needle', 'needle')] },
  });

  const { matches } = await collect(runRipgrep, [projectRoot], 'needle');

  assert.equal(matches.length, 1);
});

test('an already aborted search starts no process', async () => {
  const { runRipgrep, calls } = createFakeRipgrep({});
  const abortController = new AbortController();
  abortController.abort();

  const { truncated } = await collect(runRipgrep, [projectRoot], 'needle', {}, abortController.signal);

  assert.deepEqual(calls, []);
  assert.equal(truncated, false);
});

test('the bundled ripgrep finds text in a real folder, honouring filters, skipped folders and a bad pattern', async () => {
  const folderPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cloudcli-content-search-'));
  try {
    await fsPromises.mkdir(path.join(folderPath, 'src'));
    await fsPromises.mkdir(path.join(folderPath, 'node_modules', 'dependency'), { recursive: true });
    await fsPromises.writeFile(path.join(folderPath, 'src', 'main.ts'), 'first line\r\n  const Needle = 1;\r\n');
    await fsPromises.writeFile(path.join(folderPath, 'src', 'main.ts.meta'), 'needle\n');
    await fsPromises.writeFile(path.join(folderPath, 'node_modules', 'dependency', 'index.js'), 'needle\n');
    await fsPromises.writeFile(path.join(folderPath, '.hidden'), 'needle\n');

    const everything = await collect(runRipgrepJson, [folderPath], 'needle');
    assert.deepEqual(everything.matches.map((match) => match.relativePath).sort(), ['.hidden', 'src/main.ts', 'src/main.ts.meta']);

    const filtered = await collect(runRipgrepJson, [folderPath], 'needle', { globs: ['*.ts'] });
    assert.deepEqual(filtered.matches, [{
      path: path.join(folderPath, 'src', 'main.ts'),
      relativePath: 'src/main.ts',
      rootPath: folderPath,
      rootIndex: 0,
      line: 2,
      character: 8,
      snippet: 'const Needle = 1;',
      highlights: [{ start: 6, end: 12 }],
    }]);

    // An upper-case letter in the query makes the search case-sensitive.
    const caseSensitive = await collect(runRipgrepJson, [folderPath], 'NEEDLE');
    assert.deepEqual(caseSensitive.matches, []);

    await assert.rejects(
      collect(runRipgrepJson, [folderPath], 'a(', { regex: true }),
      (error) => error instanceof AppError && /unclosed group/.test(error.message),
    );
  } finally {
    await fsPromises.rm(folderPath, { recursive: true, force: true });
  }
});
