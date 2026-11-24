import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import mime from 'mime-types';
import multer from 'multer';

import { projectsDb, sessionWorktreesDb } from '@/modules/database/index.js';
import { createFileContentSearch } from '@/modules/file-tree/file-content-search.js';
import { runRipgrepJson } from '@/modules/file-tree/file-content-search.adapters.js';
import { createFileSearchIndex } from '@/modules/file-tree/file-search-index.js';
import { listFilesWithRipgrep, watchFolderRecursively } from '@/modules/file-tree/file-search-index.adapters.js';
import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import { createFileTreeService } from '@/modules/file-tree/file-tree.service.js';
import { providerSkillsService } from '@/modules/providers/index.js';
import { mapFoldersToSessionWorktrees } from '@/modules/worktree-claims/index.js';
import type {
  FileTreeFileSystem,
  FileTreeLogger,
  FileTreeProjectGateway,
  FileTreeWorkspaceGateway,
} from '@/shared/types.js';
import { WORKSPACES_ROOT, resolveReadOnlyRootPath, validateWorkspacePath } from '@/shared/utils.js';

const MAXIMUM_UPLOAD_SIZE_MEGABYTES = 200;
const MAXIMUM_UPLOAD_SIZE_BYTES = MAXIMUM_UPLOAD_SIZE_MEGABYTES * 1024 * 1024;
const MAXIMUM_UPLOAD_FILE_COUNT = 20;

function readFileSystemConcurrency(): number {
  const configuredConcurrency = Number.parseInt(process.env.FS_CONCURRENCY ?? '', 10);
  return Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? configuredConcurrency
    : 64;
}

/**
 * Production filesystem adapter owned by the File Tree composition root.
 * Application services receive this complete capability explicitly and never
 * import Node's mutable filesystem APIs themselves.
 */
const fileTreeFileSystem: FileTreeFileSystem = {
  access: (candidatePath) => fsPromises.access(candidatePath),
  stat: (candidatePath) => fsPromises.stat(candidatePath),
  lstat: (candidatePath) => fsPromises.lstat(candidatePath),
  // `opendir` streams entries in batches; the iterator protocol closes the handle.
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
  copyFile: (sourcePath, destinationPath) => fsPromises.copyFile(sourcePath, destinationPath),
  createReadStream: (filePath) => fs.createReadStream(filePath),
};

/**
 * Database boundary used only by File Tree production composition.
 * The Database module is consumed through its barrel; services and routes see
 * only the narrow project-folders lookup contract.
 */
const fileTreeProjects: FileTreeProjectGateway = {
  getProjectFolderPathsById: (projectId) => projectsDb.getProjectFolderPathsById(projectId),
};

/**
 * Workspace-policy boundary used only by File Tree production composition.
 * Keeping both the configured root and symlink-aware validator together makes
 * the path policy explicit for every service instance.
 */
const fileTreeWorkspace: FileTreeWorkspaceGateway = {
  rootPath: WORKSPACES_ROOT,
  validatePath: (candidatePath) => validateWorkspacePath(candidatePath),
  resolveReadOnlyRootPath: (candidatePath) => resolveReadOnlyRootPath(candidatePath),
};

const fileTreeLogger: FileTreeLogger = {
  error: (message, error) => console.error(message, error),
};

/** Explorer, Finder or the Linux desktop's file manager, on the machine the server runs on. */
function revealInFileManager(targetPath: string): void {
  const [command, args, windowsVerbatimArguments] = process.platform === 'win32'
    // Explorer reads `/select,"<path>"` itself, so Node must not quote the argument as a whole.
    ? ['explorer.exe', [`/select,"${path.win32.normalize(targetPath)}"`], true]
    : process.platform === 'darwin'
      ? ['open', ['-R', targetPath], false]
      : ['xdg-open', [path.dirname(targetPath)], false];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments });
  child.on('error', (error) => fileTreeLogger.error(`Could not reveal ${targetPath}`, error));
  child.unref();
}

const fileSearchIndex = createFileSearchIndex({
  listFiles: listFilesWithRipgrep,
  watchFolder: watchFolderRecursively,
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  logger: fileTreeLogger,
});

const fileTreeServices = createFileTreeService({
  fileSystem: fileTreeFileSystem,
  projects: fileTreeProjects,
  workspace: fileTreeWorkspace,
  resolveMimeType: (filePath) => mime.lookup(filePath) || 'application/octet-stream',
  fileSystemConcurrency: readFileSystemConcurrency(),
  fileIndex: fileSearchIndex,
  contentSearch: createFileContentSearch({ runRipgrep: runRipgrepJson }),
  logger: fileTreeLogger,
  revealInFileManager,
  sessionFolders: {
    mapFolders: (folders, sessionId) => mapFoldersToSessionWorktrees(folders, sessionWorktreesDb.listBySession(sessionId)),
  },
  skillFiles: {
    resolveEditablePath: (targetPath) => providerSkillsService.resolveManagedSkillPath(targetPath),
  },
});

const fileUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_request, _file, callback) => {
      callback(null, `cloudcli-file-upload-${randomUUID()}`);
    },
  }),
  limits: {
    fileSize: MAXIMUM_UPLOAD_SIZE_BYTES,
    files: MAXIMUM_UPLOAD_FILE_COUNT,
  },
}).array('files', MAXIMUM_UPLOAD_FILE_COUNT);

/**
 * File Tree router used by the server entrypoint to mount the authenticated
 * browsing, editing, file-management, and upload API under `/api/file-tree`.
 */
export const fileTreeRoutes = createFileTreeRouter(
  fileTreeServices,
  fileUploadMiddleware,
  {
    maximumFileSizeMegabytes: MAXIMUM_UPLOAD_SIZE_MEGABYTES,
    maximumFileCount: MAXIMUM_UPLOAD_FILE_COUNT,
  },
  fileTreeLogger,
);
