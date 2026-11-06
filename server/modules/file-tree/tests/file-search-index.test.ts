import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createFileSearchIndex } from '@/modules/file-tree/file-search-index.js';
import type { FileTreeFileIndexDependencies } from '@/shared/types.js';

type FakeFolders = Record<string, { files: string[]; gitignore?: string }>;

function createFakeDependencies(folders: FakeFolders) {
  const listCalls: string[] = [];
  const changeListeners = new Map<string, (relativePath: string | null) => void>();
  const dependencies: FileTreeFileIndexDependencies = {
    listFiles: async (folderPath) => {
      listCalls.push(folderPath);
      return [...folders[folderPath].files];
    },
    watchFolder: (folderPath, onChange) => {
      changeListeners.set(folderPath, onChange);
      return () => changeListeners.delete(folderPath);
    },
    readTextFile: async (filePath) => {
      const gitignore = folders[path.dirname(filePath)]?.gitignore;
      if (gitignore === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return gitignore;
    },
    logger: { error: () => undefined },
  };
  return { dependencies, listCalls, changeListeners };
}

const projectRoot = path.resolve('search-project');

test('a search ranks an exact name above a prefix, a substring, a path and a scattered match', async () => {
  const { dependencies } = createFakeDependencies({
    [projectRoot]: {
      files: ['src/main.ts', 'src/mainframe.ts', 'src/domain.ts', 'main/readme.md', 'src/m-a-i-n.ts'],
    },
  });
  const index = createFileSearchIndex(dependencies);

  const { results } = await index.search([projectRoot], 'main.ts', { limit: 10, type: 'any' });
  assert.equal(results[0].relativePath, 'src/main.ts');
  assert.equal(results.some((result) => result.relativePath === 'main/readme.md'), false);

  const ranked = await index.search([projectRoot], 'main', { limit: 10, type: 'file' });
  assert.deepEqual(ranked.results.map((result) => result.relativePath), [
    'src/main.ts',
    'src/mainframe.ts',
    'src/domain.ts',
    'main/readme.md',
    'src/m-a-i-n.ts',
  ]);
});

test('directories are searchable, and a file-only search leaves them out', async () => {
  const { dependencies } = createFakeDependencies({
    [projectRoot]: { files: ['Assets/Scripts/Player.cs'] },
  });
  const index = createFileSearchIndex(dependencies);

  const any = await index.search([projectRoot], 'scripts', { limit: 10, type: 'any' });
  assert.deepEqual(any.results.map((result) => [result.relativePath, result.type]), [
    ['Assets/Scripts', 'directory'],
    ['Assets/Scripts/Player.cs', 'file'],
  ]);
  assert.equal(any.results[0].path, path.join(projectRoot, 'Assets', 'Scripts'));

  const files = await index.search([projectRoot], 'scripts', { limit: 10, type: 'file' });
  assert.deepEqual(files.results.map((result) => result.relativePath), ['Assets/Scripts/Player.cs']);
});

test('a file of a nested project folder is found only under that folder', async () => {
  const nested = path.join(projectRoot, 'Packages', 'Misc');
  const { dependencies } = createFakeDependencies({
    [projectRoot]: { files: ['readme.md', 'Packages/Misc/misc.cs'] },
    [nested]: { files: ['misc.cs'] },
  });
  const index = createFileSearchIndex(dependencies);

  const { results } = await index.search([projectRoot, nested], 'misc', { limit: 10, type: 'file' });

  assert.deepEqual(results.map((result) => [result.rootIndex, result.relativePath]), [[1, 'misc.cs']]);
});

test('an empty query lists entries up to the limit and says there are more', async () => {
  const { dependencies } = createFakeDependencies({
    [projectRoot]: { files: ['a.txt', 'b.txt', 'c.txt'] },
  });
  const index = createFileSearchIndex(dependencies);

  const { results, truncated } = await index.search([projectRoot], '', { limit: 2, type: 'file' });

  assert.equal(results.length, 2);
  assert.equal(truncated, true);
});

test('a change the root .gitignore excludes does not relist the folder, any other change does', async () => {
  const folders: FakeFolders = { [projectRoot]: { files: ['a.txt'], gitignore: 'Library/\n' } };
  const { dependencies, listCalls, changeListeners } = createFakeDependencies(folders);
  const index = createFileSearchIndex(dependencies);
  await index.search([projectRoot], 'a', { limit: 10, type: 'file' });
  assert.equal(listCalls.length, 1);

  changeListeners.get(projectRoot)?.(path.join('Library', 'cache.bin'));
  changeListeners.get(projectRoot)?.(path.join('.git', 'index'));
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(listCalls.length, 1);

  folders[projectRoot].files.push('b.txt');
  changeListeners.get(projectRoot)?.('b.txt');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(listCalls.length, 2);

  const { results } = await index.search([projectRoot], 'b.txt', { limit: 10, type: 'file' });
  assert.deepEqual(results.map((result) => result.relativePath), ['b.txt']);
});
