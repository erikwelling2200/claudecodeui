import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import type {
  FileTreeDirectoryEntry,
  FileTreeFileSystem,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeStats,
} from '@/shared/types.js';
import { AppError, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function createDirectoryEntry(name: string, directory: boolean): FileTreeDirectoryEntry {
  return {
    name,
    isDirectory: () => directory,
  };
}

/**
 * Adapts a path-keyed listing to the streaming directory contract so tests keep
 * describing directories as plain arrays.
 */
function createDirectoryReader(
  listDirectory: (directoryPath: string) => FileTreeDirectoryEntry[],
): FileTreeFileSystem['openDirectory'] {
  return async function* openDirectory(directoryPath) {
    yield* listDirectory(directoryPath);
  };
}

function createStats(directory: boolean, mode: number): FileTreeStats {
  return {
    size: directory ? 0 : 24,
    mtime: new Date('2026-01-02T03:04:05.000Z'),
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
  };
}

function createFakeFileSystem(
  overrides: Partial<FileTreeFileSystem> = {},
): FileTreeFileSystem {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree filesystem operation');
  };

  return {
    access: unexpectedOperation,
    stat: unexpectedOperation,
    lstat: unexpectedOperation,
    openDirectory: () => ({
      [Symbol.asyncIterator]: () => ({ next: unexpectedOperation }),
    }),
    realpath: unexpectedOperation,
    readTextFile: unexpectedOperation,
    writeTextFile: unexpectedOperation,
    makeDirectory: unexpectedOperation,
    rename: unexpectedOperation,
    removeDirectory: unexpectedOperation,
    unlink: unexpectedOperation,
    copyFile: unexpectedOperation,
    createReadStream: () => Readable.from([]),
    ...overrides,
  };
}

function createDependencies(
  fileSystem: FileTreeFileSystem,
  projectRoot: string,
): FileTreeServiceDependencies {
  return {
    fileSystem,
    projects: {
      getProjectFolderPathsById: async () => [projectRoot],
    },
    workspace: {
      rootPath: projectRoot,
      validatePath: async (candidatePath) => ({ valid: true, resolvedPath: candidatePath }),
      resolveReadOnlyRootPath: async () => null,
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  };
}

test('listProjectFiles applies gitignore alongside hard directory exclusions', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const gitDirectory = path.join(projectRoot, '.git');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return '*.log';
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.git', true),
          createDirectoryEntry('node_modules', true),
          createDirectoryEntry('README.md', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [createDirectoryEntry('build', true)];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('foo.md', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [createDirectoryEntry('index.ts', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === documentationDirectory
        || candidatePath === buildDocumentationDirectory
        || candidatePath === sourceDirectory
        || candidatePath === gitDirectory
        || candidatePath === nodeModulesDirectory,
      0o754,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'src', 'README.md']);
  const documentationEntry = tree[0];
  assert.deepEqual(documentationEntry?.children?.map((entry) => entry.name), ['build']);
  assert.deepEqual(documentationEntry?.children?.[0]?.children?.map((entry) => entry.name), ['foo.md']);
  const sourceEntry = tree[1];
  assert.ok(sourceEntry);
  assert.equal(sourceEntry.type, 'directory');
  assert.equal(sourceEntry.permissions, '754');
  assert.equal(sourceEntry.permissionsRwx, 'rwxr-xr--');
  assert.deepEqual(sourceEntry.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(gitDirectory), false);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
});

test('listProjectFiles excludes gitignored entries only when requested', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const cacheDirectory = path.join(projectRoot, 'cache');
  const sourceDirectory = path.join(projectRoot, 'src');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async (filePath) => {
      assert.equal(filePath, path.join(projectRoot, '.gitignore'));
      return ['*.log', '!keep.log', 'cache/', 'src/generated.ts'].join('\n');
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('.gitignore', false),
          createDirectoryEntry('cache', true),
          createDirectoryEntry('ignored.log', false),
          createDirectoryEntry('keep.log', false),
          createDirectoryEntry('src', true),
        ];
      }
      if (directoryPath === cacheDirectory) {
        return [createDirectoryEntry('cached.txt', false)];
      }
      if (directoryPath === sourceDirectory) {
        return [
          createDirectoryEntry('generated.ts', false),
          createDirectoryEntry('index.ts', false),
        ];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(
      candidatePath === cacheDirectory || candidatePath === sourceDirectory,
      0o644,
    ),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['src', '.gitignore', 'keep.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['index.ts']);
  assert.equal(readDirectories.includes(cacheDirectory), false);
});

test('listProjectFiles falls back to conventional directory names when no gitignore exists', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const documentationDirectory = path.join(projectRoot, 'docs');
  const buildDocumentationDirectory = path.join(documentationDirectory, 'build');
  const nodeModulesDirectory = path.join(projectRoot, 'node_modules');
  const readDirectories: string[] = [];
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    readTextFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    openDirectory: createDirectoryReader((directoryPath) => {
      readDirectories.push(directoryPath);
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('debug.log', false),
          createDirectoryEntry('docs', true),
          createDirectoryEntry('node_modules', true),
        ];
      }
      if (directoryPath === documentationDirectory) {
        return [
          createDirectoryEntry('build', true),
          createDirectoryEntry('guide.md', false),
        ];
      }
      if (directoryPath === buildDocumentationDirectory) {
        return [createDirectoryEntry('generated.md', false)];
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(candidatePath === documentationDirectory, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

  assert.deepEqual(tree.map((entry) => entry.name), ['docs', 'debug.log']);
  assert.deepEqual(tree[0]?.children?.map((entry) => entry.name), ['guide.md']);
  assert.equal(readDirectories.includes(nodeModulesDirectory), false);
  assert.equal(readDirectories.includes(buildDocumentationDirectory), false);
});

test('listProjectFiles rejects a tree that exceeds the server entry limit', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => directoryPath === projectRoot
      ? Array.from({ length: 10_001 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false))
      : []),
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('listProjectFiles lists an oversized folder of a multi-folder project empty and still lists the others', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const smallFolder = path.resolve('file-tree-small-folder');
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Twenty sibling directories are walked in parallel, so some walks are still
    // running after the overflow rejects the oversized folder.
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return Array.from({ length: 20 }, (_, index) => createDirectoryEntry(`dir-${index}`, true));
      }
      if (path.dirname(directoryPath) === projectRoot) {
        return Array.from({ length: 1_000 }, (_, index) => createDirectoryEntry(`file-${index}.txt`, false));
      }
      return directoryPath === smallFolder ? [createDirectoryEntry('readme.md', false)] : [];
    }),
    lstat: async (candidatePath) => createStats(path.basename(candidatePath).startsWith('dir-'), 0o644),
  });
  const service = createFileTreeService({
    ...createDependencies(fileSystem, projectRoot),
    projects: { getProjectFolderPathsById: async () => [projectRoot, smallFolder] },
  });

  const tree = await service.listProjectFiles('project-1');

  assert.equal(tree[0].isTooLarge, true);
  assert.deepEqual(tree[0].children, []);
  assert.equal(tree[1].isTooLarge, undefined);
  assert.deepEqual(tree[1].children?.map((node) => node.name), ['readme.md']);
});

test('listProjectFiles abandons a directory stream as soon as the entry limit is passed', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  let streamedEntries = 0;
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    // Endless on purpose: the walk has to stop consuming the stream itself
    // instead of waiting for the directory listing to be materialized.
    openDirectory: async function* (directoryPath) {
      if (directoryPath !== projectRoot) {
        return;
      }
      for (let index = 0; ; index += 1) {
        streamedEntries += 1;
        yield createDirectoryEntry(`file-${index}.txt`, false);
      }
    },
    lstat: async () => createStats(false, 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
  // The budget plus the single entry that proves it was exceeded.
  assert.equal(streamedEntries, 10_001);
});

test('listProjectFiles shares the entry limit across nested directories', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const firstDirectory = path.join(projectRoot, 'first');
  const secondDirectory = path.join(projectRoot, 'second');
  const directoryPaths = new Set([firstDirectory, secondDirectory]);
  const fileSystem = createFakeFileSystem({
    access: async () => undefined,
    openDirectory: createDirectoryReader((directoryPath) => {
      if (directoryPath === projectRoot) {
        return [
          createDirectoryEntry('first', true),
          createDirectoryEntry('second', true),
        ];
      }
      if (directoryPaths.has(directoryPath)) {
        return Array.from(
          { length: 5_000 },
          (_, index) => createDirectoryEntry(`${path.basename(directoryPath)}-${index}.txt`, false),
        );
      }
      return [];
    }),
    lstat: async (candidatePath) => createStats(directoryPaths.has(candidatePath), 0o644),
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.listProjectFiles('project-1'),
    (error: unknown) => error instanceof AppError
      && error.code === 'FILE_TREE_TOO_LARGE'
      && error.statusCode === 413,
  );
});

test('readTextFile rejects traversal before invoking the filesystem adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const readPaths: string[] = [];
  const fileSystem = createFakeFileSystem({
    readTextFile: async (filePath) => {
      readPaths.push(filePath);
      return 'should not be read';
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', '../secret.txt'),
    (error: unknown) => error instanceof AppError
      && error.code === 'PATH_OUTSIDE_PROJECT'
      && error.statusCode === 403,
  );
  assert.deepEqual(readPaths, []);
});

test('readTextFile reports a directory as a client error, not a 500', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const fileSystem = createFakeFileSystem({
    readTextFile: async () => {
      const error = new Error('EISDIR: illegal operation on a directory, read');
      (error as NodeJS.ErrnoException).code = 'EISDIR';
      throw error;
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  await assert.rejects(
    service.readTextFile('project-1', 'decisions'),
    (error: unknown) => error instanceof AppError
      && error.code === 'EISDIR'
      && error.statusCode === 400
      && error.message === 'Path is a directory, not a file',
  );
});

test('createEntry performs filesystem mutation only through the injected adapter', async () => {
  const projectRoot = path.resolve('file-tree-test-project');
  const targetPath = path.join(projectRoot, 'notes.txt');
  const writtenFiles: Array<{ filePath: string; content: string }> = [];
  const fileSystem = createFakeFileSystem({
    access: async (candidatePath) => {
      if (candidatePath === targetPath) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
    },
    writeTextFile: async (filePath, content) => {
      writtenFiles.push({ filePath, content });
    },
  });
  const service = createFileTreeService(createDependencies(fileSystem, projectRoot));

  const result = await service.createEntry({
    projectId: 'project-1',
    parentPath: projectRoot,
    type: 'file',
    name: 'notes.txt',
  });

  assert.equal(result.path, targetPath);
  assert.deepEqual(writtenFiles, [{ filePath: targetPath, content: '' }]);
});

/**
 * Builds the service against the real filesystem and the real workspace policy,
 * which is the only way to exercise the read-only roots: the whole guarantee
 * rests on `realpath` resolving symlinks before the comparison.
 */
function createRealFileSystemService(
  projectRoot: string,
  workspaceRoot = projectRoot,
  additionalFolders: string[] = [],
): FileTreeServices {
  return createFileTreeService({
    fileSystem: {
      access: (candidatePath) => fsPromises.access(candidatePath),
      stat: (candidatePath) => fsPromises.stat(candidatePath),
      lstat: (candidatePath) => fsPromises.lstat(candidatePath),
      openDirectory: async function* (directoryPath) {
        yield* await fsPromises.opendir(directoryPath);
      },
      realpath: (candidatePath) => fsPromises.realpath(candidatePath),
      readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
      writeTextFile: (filePath, content) => fsPromises.writeFile(filePath, content, 'utf8'),
      async makeDirectory(directoryPath, recursive) {
        await fsPromises.mkdir(directoryPath, { recursive });
      },
      rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
      async removeDirectory(directoryPath) {
        await fsPromises.rm(directoryPath, { recursive: true, force: true });
      },
      unlink: (filePath) => fsPromises.unlink(filePath),
      copyFile: (source, destination) => fsPromises.copyFile(source, destination),
      createReadStream: (filePath) => createReadStream(filePath),
    },
    projects: { getProjectFolderPathsById: async () => [projectRoot, ...additionalFolders] },
    workspace: {
      rootPath: workspaceRoot,
      validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
      resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
    },
    resolveMimeType: () => 'text/plain',
    fileSystemConcurrency: 4,
    logger: { error: () => undefined },
  });
}

test('the temp directory can be browsed and read, but never written to', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));

  try {
    // The shape a task notification quotes: an agent's output file written to
    // the system temp directory, outside every project.
    await fsPromises.mkdir(path.join(temporaryDirectory, 'tasks'));
    const outputPath = path.join(temporaryDirectory, 'tasks', 'agent.output');
    await fsPromises.writeFile(outputPath, 'what the agent found', 'utf8');

    const service = createRealFileSystemService(projectRoot);

    const browsed = await service.browseWorkspace(temporaryDirectory);
    assert.deepEqual(browsed.suggestions.map((entry) => entry.name), ['tasks']);

    const opened = await service.readTextFile('project-1', outputPath);
    assert.equal(opened.content, 'what the agent found');

    const streamed = await service.openFile('project-1', outputPath);
    streamed.stream.destroy();

    // Read-only means read-only: nothing may be created or changed there.
    await assert.rejects(
      service.saveTextFile('project-1', outputPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.createWorkspaceFolder(path.join(temporaryDirectory, 'new-folder')),
      (error: unknown) => (error as AppError).code === 'INVALID_WORKSPACE_PATH',
    );
    await assert.rejects(
      service.createEntry({
        projectId: 'project-1',
        parentPath: path.join(temporaryDirectory, 'tasks'),
        type: 'file',
        name: 'planted.txt',
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.renameEntry({ projectId: 'project-1', oldPath: outputPath, newName: 'renamed.output' }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    const uploadedTemporaryPath = path.join(projectRoot, 'upload.tmp');
    await fsPromises.writeFile(uploadedTemporaryPath, 'upload', 'utf8');
    await assert.rejects(
      service.storeUploadedFiles({
        projectId: 'project-1',
        targetPath: path.join(temporaryDirectory, 'tasks'),
        relativePaths: [],
        requestedFileCount: 1,
        files: [{ originalName: 'upload.txt', temporaryPath: uploadedTemporaryPath, size: 6, mimeType: 'text/plain' }],
      }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: outputPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.deepEqual(await fsPromises.readdir(path.join(temporaryDirectory, 'tasks')), ['agent.output']);
    assert.equal(await fsPromises.readFile(outputPath, 'utf8'), 'what the agent found');
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
  }
});

test('reading through a symlink out of the temp directory is still refused', async () => {
  const temporaryDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-tmp-'));
  const projectRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-project-'));
  // The link target has to sit under no read-only root. Beside this file is
  // deterministic; a directory under `$HOME` lands under `/tmp` whenever a
  // test run isolates its home there, and the Claude projects directory is a
  // read-only root too.
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    assert.equal(await resolveReadOnlyRootPath(outsideDirectory), null);
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(temporaryDirectory, 'escape'));

    const service = createRealFileSystemService(projectRoot);
    await assert.rejects(
      service.readTextFile('project-1', path.join(temporaryDirectory, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(temporaryDirectory, { recursive: true, force: true });
    await fsPromises.rm(projectRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

test('a file in another folder of the workspace can be read, but never written to', async () => {
  // Both sit beside this file, outside every read-only root, for the reason
  // given in the symlink test above.
  const workspaceRoot = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'project');
  const siblingDirectory = path.join(workspaceRoot, '.runs', 'run-1');
  const outsideDirectory = await fsPromises.mkdtemp(path.join(testDirectory, 'file-tree-outside-'));

  try {
    await fsPromises.mkdir(projectRoot);
    await fsPromises.mkdir(siblingDirectory, { recursive: true });
    const reportPath = path.join(siblingDirectory, 'report.md');
    await fsPromises.writeFile(reportPath, 'what the run found', 'utf8');
    await fsPromises.writeFile(path.join(outsideDirectory, 'secret.txt'), 'secret', 'utf8');
    await fsPromises.symlink(outsideDirectory, path.join(workspaceRoot, 'escape'));

    const service = createRealFileSystemService(projectRoot, workspaceRoot);

    const opened = await service.readTextFile('project-1', reportPath);
    assert.equal(opened.content, 'what the run found');
    const streamed = await service.openFile('project-1', reportPath);
    streamed.stream.destroy();

    await assert.rejects(
      service.saveTextFile('project-1', reportPath, 'overwritten'),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    await assert.rejects(
      service.deleteEntry({ projectId: 'project-1', targetPath: reportPath }),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
    assert.equal(await fsPromises.readFile(reportPath, 'utf8'), 'what the run found');

    // A link inside the workspace does not open what lies outside it.
    await assert.rejects(
      service.readTextFile('project-1', path.join(workspaceRoot, 'escape', 'secret.txt')),
      (error: unknown) => (error as AppError).code === 'PATH_OUTSIDE_PROJECT',
    );
  } finally {
    await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    await fsPromises.rm(outsideDirectory, { recursive: true, force: true });
  }
});

type MultiFolderLayout = {
  primary: string;
  shared: string;
  otherShared: string;
  nested: string;
  missing: string;
  outside: string;
  service: FileTreeServices;
};

/**
 * A project of five folders on the real filesystem: the primary (which
 * gitignores `Packages/`), a folder nested in it under `Packages`, two folders
 * that are both named `Shared`, and one that does not exist. The workspace
 * root is the primary alone, so reaching the other folders relies on them
 * being project folders.
 */
async function withMultiFolderProject(runTest: (layout: MultiFolderLayout) => Promise<void>): Promise<void> {
  const base = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'file-tree-folders-')));
  const primary = path.join(base, 'primary');
  const nested = path.join(primary, 'Packages', 'Nested');
  const shared = path.join(base, 'libs', 'Shared');
  const otherShared = path.join(base, 'apps', 'Shared');
  const missing = path.join(base, 'missing');
  await fsPromises.mkdir(path.join(primary, 'src'), { recursive: true });
  await fsPromises.mkdir(nested, { recursive: true });
  await fsPromises.mkdir(shared, { recursive: true });
  await fsPromises.mkdir(otherShared, { recursive: true });
  await fsPromises.writeFile(path.join(primary, '.gitignore'), 'Packages/\n');
  await fsPromises.writeFile(path.join(primary, 'src', 'index.ts'), '');
  await fsPromises.writeFile(path.join(primary, 'Packages', 'loose.txt'), '');
  await fsPromises.writeFile(path.join(nested, 'nested.txt'), '');
  await fsPromises.writeFile(path.join(shared, 'shared.txt'), 'shared');
  await fsPromises.writeFile(path.join(otherShared, 'other.txt'), 'other');

  try {
    await runTest({
      primary,
      shared,
      otherShared,
      nested,
      missing,
      outside: path.join(base, 'outside.txt'),
      service: createRealFileSystemService(primary, primary, [shared, nested, otherShared, missing]),
    });
  } finally {
    await fsPromises.rm(base, { recursive: true, force: true });
  }
}

function assertFileTreeError(code: string, statusCode = 403) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}

test('listProjectFiles shows each folder of a multi-folder project as a top-level node', async () => {
  await withMultiFolderProject(async ({ primary, shared, otherShared, nested, missing, service }) => {
    const tree = await service.listProjectFiles('project-1', { respectGitignore: false });

    assert.deepEqual(
      tree.map((node) => ({ name: node.name, path: node.path, isProjectRoot: node.isProjectRoot })),
      [
        { name: 'primary', path: primary, isProjectRoot: true },
        { name: 'libs/Shared', path: shared, isProjectRoot: true },
        { name: 'Nested', path: nested, isProjectRoot: true },
        { name: 'apps/Shared', path: otherShared, isProjectRoot: true },
        { name: 'missing', path: missing, isProjectRoot: true },
      ],
    );
    assert.ok(tree.every((node) => node.type === 'directory'));

    // Without gitignore filtering `Packages` is listed, but the nested project
    // folder inside it appears only as its own top-level node.
    const packages = tree[0].children?.find((node) => node.name === 'Packages');
    assert.deepEqual(packages?.children?.map((node) => node.name), ['loose.txt']);
    assert.deepEqual(tree[2].children?.map((node) => node.name), ['nested.txt']);
    assert.deepEqual(tree[1].children?.map((node) => node.name), ['shared.txt']);

    assert.equal(tree[4].isUnavailable, true);
    assert.deepEqual(tree[4].children, []);
    assert.equal(tree[0].isUnavailable, undefined);
  });
});

test('listProjectFiles applies each folder its own gitignore', async () => {
  await withMultiFolderProject(async ({ service }) => {
    const tree = await service.listProjectFiles('project-1', { respectGitignore: true });

    assert.deepEqual(tree[0].children?.map((node) => node.name), ['src', '.gitignore']);
    assert.deepEqual(tree[1].children?.map((node) => node.name), ['shared.txt']);
  });
});

test('writes reach every project folder, and relative paths stay in the primary', async () => {
  await withMultiFolderProject(async ({ primary, shared, otherShared, outside, service }) => {
    const saved = await service.saveTextFile('project-1', path.join(shared, 'saved.txt'), 'saved');
    assert.equal(saved.path, path.join(shared, 'saved.txt'));
    assert.equal(await fsPromises.readFile(path.join(shared, 'saved.txt'), 'utf8'), 'saved');

    const relative = await service.saveTextFile('project-1', 'relative.txt', 'relative');
    assert.equal(relative.path, path.join(primary, 'relative.txt'));

    const created = await service.createEntry({ projectId: 'project-1', parentPath: otherShared, type: 'file', name: 'made.txt' });
    assert.equal(created.path, path.join(otherShared, 'made.txt'));

    const read = await service.readTextFile('project-1', path.join(otherShared, 'other.txt'));
    assert.equal(read.content, 'other');

    await assert.rejects(service.saveTextFile('project-1', outside, 'nope'), assertFileTreeError('PATH_OUTSIDE_PROJECT'));
    await assert.rejects(service.saveTextFile('project-1', '../outside.txt', 'nope'), assertFileTreeError('PATH_OUTSIDE_PROJECT'));
  });
});

test('a project folder itself can be neither renamed nor deleted', async () => {
  await withMultiFolderProject(async ({ primary, shared, nested, service }) => {
    for (const folder of [primary, shared, nested]) {
      await assert.rejects(
        service.renameEntry({ projectId: 'project-1', oldPath: folder, newName: 'renamed' }),
        assertFileTreeError('PROJECT_ROOT_RENAME_FORBIDDEN'),
      );
      await assert.rejects(
        service.deleteEntry({ projectId: 'project-1', targetPath: folder }),
        assertFileTreeError('PROJECT_ROOT_DELETE_FORBIDDEN'),
      );
    }
    await fsPromises.access(nested);

    const renamed = await service.renameEntry({
      projectId: 'project-1',
      oldPath: path.join(shared, 'shared.txt'),
      newName: 'renamed.txt',
    });
    assert.equal(renamed.newPath, path.join(shared, 'renamed.txt'));
  });
});

test('files can be uploaded onto an extra project folder', async () => {
  await withMultiFolderProject(async ({ shared, service }) => {
    const temporaryPath = path.join(os.tmpdir(), `file-tree-upload-${process.pid}-${Date.now()}`);
    await fsPromises.writeFile(temporaryPath, 'uploaded');

    const result = await service.storeUploadedFiles({
      projectId: 'project-1',
      targetPath: shared,
      relativePaths: [],
      requestedFileCount: 1,
      files: [{ originalName: 'upload.txt', temporaryPath, size: 8, mimeType: 'text/plain' }],
    });

    assert.equal(result.uploadedCount, 1);
    assert.equal(result.targetPath, shared);
    assert.equal(await fsPromises.readFile(path.join(shared, 'upload.txt'), 'utf8'), 'uploaded');
  });
});
