import path from 'node:path';

import ignore from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  getPathComparisonKey,
  isPathInsideFolder,
  isSameFolderPath,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// The tree is listed a few levels at a time as the browser expands it, so a
// request never needs more than this; it keeps one call from walking a disk.
const MAXIMUM_LISTING_DEPTH = 10;

function clampListingDepth(depth: number | undefined): number {
  if (depth === undefined || !Number.isFinite(depth)) return 1;
  return Math.min(MAXIMUM_LISTING_DEPTH, Math.max(1, Math.floor(depth)));
}

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  const name = path.basename(entryPath);
  // A linked worktree's `.git` is a file pointing at the git directory; as much noise as the directory.
  if (name === '.git') return false;
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(name);
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

type ProjectFolders = {
  primary: string;
  /** The primary folder first, then the extra folders in order. */
  all: string[];
  /** One entry per folder in `all`, carrying the worktree it stands in for when a chat is parked in one. */
  roots: ProjectRoot[];
};

type ProjectRoot = {
  path: string;
  /** The project folder as the project records it: the main checkout. */
  mainPath: string;
  /** '' when `path` is the main checkout. */
  suffix: string;
  branch: string | null;
  /** The chat's worktree folder does not exist, so `path` is the main checkout instead. */
  missing: boolean;
};

function isProjectFolder(folders: ProjectFolders, candidatePath: string): boolean {
  return folders.all.some((folder) => isSameFolderPath(folder, candidatePath));
}

/**
 * Resolves a client path to an absolute path inside one of the project's
 * folders. A relative path resolves against the primary folder, as it did
 * when a project had only one; an absolute path may point into any folder.
 * `allowFolderRoot` also accepts a project folder itself (an upload target).
 */
function resolvePathInsideProjectFolders(
  folders: ProjectFolders,
  targetPath: string,
  { allowFolderRoot }: { allowFolderRoot: boolean } = { allowFolderRoot: false },
): string {
  const isAbsoluteTarget = path.isAbsolute(targetPath);
  const resolvedPath = isAbsoluteTarget
    ? path.resolve(targetPath)
    : path.resolve(folders.primary, targetPath);
  const candidateFolders = isAbsoluteTarget ? folders.all : [folders.primary];
  const isInsideProject = candidateFolders.some((folder) => isPathInsideFolder(folder, resolvedPath)
    || (allowFolderRoot && isSameFolderPath(folder, resolvedPath)));

  if (!isInsideProject) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

/**
 * Top-level node names: the folder name, or `parent/name` when two folders of
 * the project share a name, so the user can tell them apart.
 */
function createProjectRootNames(folderPaths: string[]): string[] {
  const baseNames = folderPaths.map((folderPath) => path.basename(folderPath) || folderPath);
  return folderPaths.map((folderPath, index) => {
    const baseNameKey = baseNames[index].toLowerCase();
    const isAmbiguous = baseNames.some((baseName, otherIndex) => (
      otherIndex !== index && baseName.toLowerCase() === baseNameKey
    ));
    const parentName = path.basename(path.dirname(folderPath));
    return isAmbiguous && parentName ? `${parentName}/${baseNames[index]}` : baseNames[index];
  });
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

function createGitignoreEntryFilter(
  projectRoot: string,
  gitignoreContent: string,
): FileTreeEntryFilter {
  const gitignore = ignore().add(gitignoreContent);

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    const relativePath = path.relative(projectRoot, entryPath).split(path.sep).join('/');
    const matchPath = isDirectory ? `${relativePath}/` : relativePath;
    return !gitignore.ignores(matchPath);
  };
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  /**
   * The branch a checkout has out, read from `.git/HEAD` without spawning git.
   * A linked worktree's `.git` is a file pointing at its git directory.
   */
  async function readCheckoutBranch(folderPath: string): Promise<string | null> {
    try {
      const gitPath = path.join(folderPath, '.git');
      const stats = await fileSystem.stat(gitPath);
      let gitDirectory = gitPath;
      if (!stats.isDirectory()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await fileSystem.readTextFile(gitPath));
        if (!pointer) return null;
        gitDirectory = path.resolve(folderPath, pointer[1].trim());
      }
      const head = await fileSystem.readTextFile(path.join(gitDirectory, 'HEAD'));
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
      return ref ? ref[1].trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * The project's folders, each replaced by the worktree the chat works in when
   * `sessionId` names a chat parked in one. A worktree folder that does not
   * exist falls back to the main checkout, marked `missing`, so the tree still
   * shows something rather than failing.
   */
  async function resolveProjectFolders(projectId: string, sessionId?: string): Promise<ProjectFolders> {
    const folderPaths = await dependencies.projects.getProjectFolderPathsById(projectId);
    if (!folderPaths || folderPaths.length === 0) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }

    const mapped = sessionId && dependencies.sessionFolders
      ? dependencies.sessionFolders.mapFolders(folderPaths, sessionId)
      : folderPaths.map((folder) => ({ path: folder, mainPath: folder, suffix: '', unitKey: null }));
    const roots = await Promise.all(mapped.map(async (folder): Promise<ProjectRoot> => {
      if (!folder.suffix) return { path: folder.path, mainPath: folder.mainPath, suffix: '', branch: null, missing: false };
      try {
        await fileSystem.access(folder.path);
      } catch {
        return { path: folder.mainPath, mainPath: folder.mainPath, suffix: folder.suffix, branch: null, missing: true };
      }
      return { path: folder.path, mainPath: folder.mainPath, suffix: folder.suffix, branch: await readCheckoutBranch(folder.path), missing: false };
    }));
    const all = roots.map((root) => root.path);
    return { primary: all[0], all, roots };
  }

  /** Fills size, mtime and permission bits; a metadata failure leaves the defaults. */
  async function applyEntryMetadata(item: FileTreeNode): Promise<void> {
    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(item.path);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }
  }

  async function createFolderEntryFilter(
    folderPath: string,
    respectGitignore: boolean,
  ): Promise<FileTreeEntryFilter | undefined> {
    if (!respectGitignore) {
      return undefined;
    }

    try {
      const gitignoreContent = await fileSystem.readTextFile(path.join(folderPath, '.gitignore'));
      return createGitignoreEntryFilter(folderPath, gitignoreContent);
    } catch (error) {
      if (readErrorCode(error) !== 'ENOENT') {
        dependencies.logger.error(`Error reading .gitignore in "${folderPath}"`, error);
      }
      return undefined;
    }
  }

  /**
   * The entry filter for directories inside `folderPath`: its `.gitignore` when
   * asked for (otherwise the conventional build directories), and in a
   * multi-folder project no directory that is itself another project folder,
   * so a nested folder shows only as its own top-level node.
   */
  async function createProjectFolderEntryFilter(
    folders: ProjectFolders,
    folderPath: string,
    respectGitignore: boolean,
  ): Promise<FileTreeEntryFilter> {
    const baseFilter = await createFolderEntryFilter(folderPath, respectGitignore) ?? includeEntryByFallbackDirectoryNames;
    if (folders.all.length < 2) return baseFilter;

    const folderKeys = new Set(folders.all.map(getPathComparisonKey));
    return (entryPath, isDirectory) => (
      !(isDirectory && folderKeys.has(getPathComparisonKey(entryPath))) && baseFilter(entryPath, isDirectory)
    );
  }

  /** One top-level node per project folder, primary first, each listed `depth` levels deep. */
  async function listMultiFolderProjectFiles(
    folders: ProjectFolders,
    respectGitignore: boolean,
    depth: number,
  ): Promise<FileTreeNode[]> {
    // Named after the main checkouts, so a folder keeps its name across worktrees and the badge carries the suffix.
    const rootNames = createProjectRootNames(folders.roots.map((root) => root.mainPath));

    return Promise.all(folders.all.map(async (folderPath, index) => {
      const root = folders.roots[index];
      const rootNode: FileTreeNode = {
        name: rootNames[index],
        path: folderPath,
        type: 'directory',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
        isProjectRoot: true,
        ...(root.suffix ? { worktree: { suffix: root.suffix, branch: root.branch, mainPath: root.mainPath, ...(root.missing ? { missing: true as const } : {}) } } : {}),
        children: [],
      };

      try {
        await fileSystem.access(folderPath);
      } catch {
        rootNode.isUnavailable = true;
        return rootNode;
      }

      await applyEntryMetadata(rootNode);
      const includeEntry = await createProjectFolderEntryFilter(folders, folderPath, respectGitignore);
      rootNode.children = await buildFileTree(folderPath, depth - 1, 0, includeEntry);
      return rootNode;
    }));
  }

  /** The deepest project folder that is or contains `targetPath`. */
  function findOwningFolder(folders: ProjectFolders, targetPath: string): string {
    let owner = folders.primary;
    let ownerLength = -1;
    for (const folder of folders.all) {
      const contains = isSameFolderPath(folder, targetPath) || isPathInsideFolder(folder, targetPath);
      if (contains && folder.length > ownerLength) {
        owner = folder;
        ownerLength = folder.length;
      }
    }
    return owner;
  }

  /** Reads one directory and keeps only the entries the tree will show. */
  async function collectVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
  ): Promise<FileTreeDirectoryEntry[]> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          visibleEntries.push(entry);
        }
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      // ENOENT: the browser asked for a directory deleted since it listed the parent.
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM' && errorCode !== 'ENOENT') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return [];
    } finally {
      release();
    }

    return visibleEntries;
  }

  async function buildFileTree(
    directoryPath: string,
    maximumDepth: number,
    currentDepth = 0,
    includeEntry: FileTreeEntryFilter = includeEntryByFallbackDirectoryNames,
  ): Promise<FileTreeNode[]> {
    const visibleEntries = await collectVisibleEntries(directoryPath, includeEntry);

    const items = await Promise.all(visibleEntries.map(async (entry): Promise<FileTreeNode> => {
      const itemPath = path.join(directoryPath, entry.name);
      const item: FileTreeNode = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: 0,
        modified: null,
        permissions: '000',
        permissionsRwx: '---------',
      };

      await applyEntryMetadata(item);

      // Skip recursing into pseudo-filesystems and other system-critical
      // directories (e.g. /proc, /sys) — they're never valid project roots,
      // and /proc in particular can contain thousands of virtual entries
      // that make traversal from a broad root (e.g. "/") pathologically slow.
      const isForbiddenSystemDir = FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(itemPath));

      if (entry.isDirectory() && currentDepth < maximumDepth && !isForbiddenSystemDir) {
        item.children = await buildFileTree(itemPath, maximumDepth, currentDepth + 1, includeEntry);
      }

      return item;
    }));

    return items.sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProjectFolders` alone, so nothing
   * outside the project's folders can be changed.
   */
  async function resolveReadablePath(folders: ProjectFolders, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolveExistingPathInsideProjectFolders(folders, targetPath);
  }

  /**
   * Like `resolvePathInsideProjectFolders`, but a relative path is looked up
   * in every project folder, primary first, and lands in the first one that
   * has it: an agent quotes a path relative to whichever folder it worked in.
   * A path no folder has resolves against the primary folder as before, so
   * the caller reports it the way it always did (not found, or a new file).
   */
  async function resolveExistingPathInsideProjectFolders(folders: ProjectFolders, targetPath: string): Promise<string> {
    if (!path.isAbsolute(targetPath)) {
      for (const folder of folders.all) {
        const candidatePath = path.resolve(folder, targetPath);
        if (!isPathInsideFolder(folder, candidatePath)) continue;
        try {
          await fileSystem.access(candidatePath);
          return candidatePath;
        } catch {
          // Not in this folder; try the next.
        }
      }
    }
    return resolvePathInsideProjectFolders(folders, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const fileTree = await buildFileTree(resolvedPath, 1);
      const directories = fileTree
        .filter((item) => item.type === 'directory')
        .map((item) => ({ path: item.path, name: item.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath, sessionId) {
      const folders = await resolveProjectFolders(projectId, sessionId);
      const resolvedPath = await resolveReadablePath(folders, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath, sessionId) {
      const folders = await resolveProjectFolders(projectId, sessionId);
      const resolvedPath = await resolveReadablePath(folders, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content, sessionId) {
      const folders = await resolveProjectFolders(projectId, sessionId);
      // A relative path saves over the file it was read from; a new one lands in the primary folder.
      const resolvedPath = await resolveExistingPathInsideProjectFolders(folders, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listProjectFiles(projectId, options) {
      const folders = await resolveProjectFolders(projectId, options?.sessionId);
      const respectGitignore = options?.respectGitignore === true;
      const depth = clampListingDepth(options?.depth);
      // Opening the tree is the usual prelude to a search, so the index starts building now.
      dependencies.fileIndex.warm(folders.all);
      // A single folder shown as a worktree still gets a root node, which is where the badge goes.
      if (folders.all.length > 1 || folders.roots.some((root) => root.suffix)) {
        return listMultiFolderProjectFiles(folders, respectGitignore, depth);
      }

      const projectRoot = folders.primary;
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const includeEntry = await createProjectFolderEntryFilter(folders, projectRoot, respectGitignore);
      return buildFileTree(projectRoot, depth - 1, 0, includeEntry);
    },

    async listDirectoryChildren(projectId, paths, options) {
      const folders = await resolveProjectFolders(projectId, options.sessionId);
      const depth = clampListingDepth(options.depth);
      // One filter per project folder, shared by every requested directory inside it.
      const filters = new Map<string, Promise<FileTreeEntryFilter>>();
      const listings = await Promise.all(paths.map(async (requestedPath) => {
        const directoryPath = resolvePathInsideProjectFolders(folders, requestedPath, { allowFolderRoot: true });
        const folderPath = findOwningFolder(folders, directoryPath);
        let filter = filters.get(folderPath);
        if (!filter) {
          filter = createProjectFolderEntryFilter(folders, folderPath, options.respectGitignore);
          filters.set(folderPath, filter);
        }
        return [requestedPath, await buildFileTree(directoryPath, depth - 1, 0, await filter)] as const;
      }));
      return Object.fromEntries(listings);
    },

    async searchProjectFiles(projectId, query, options) {
      const folders = await resolveProjectFolders(projectId, options.sessionId);
      return dependencies.fileIndex.search(folders.all, query, options);
    },

    async searchProjectFileContents(projectId, query, options, run) {
      const folders = await resolveProjectFolders(projectId, options.sessionId);
      return dependencies.contentSearch.search(folders.all, query, options, run);
    },

    async createEntry(input) {
      validateFilename(input.name);
      const folders = await resolveProjectFolders(input.projectId, input.sessionId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProjectFolders(folders, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const folders = await resolveProjectFolders(input.projectId, input.sessionId);
      const resolvedOldPath = resolvePathInsideProjectFolders(folders, input.oldPath, { allowFolderRoot: true });
      if (isProjectFolder(folders, resolvedOldPath)) {
        throw createFileTreeError('Cannot rename a project folder', 403, 'PROJECT_ROOT_RENAME_FORBIDDEN');
      }

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProjectFolders(folders, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const folders = await resolveProjectFolders(input.projectId, input.sessionId);
      const resolvedPath = resolvePathInsideProjectFolders(folders, input.targetPath, { allowFolderRoot: true });
      if (isProjectFolder(folders, resolvedPath)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const folders = await resolveProjectFolders(input.projectId, input.sessionId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(folders.primary)
          : resolvePathInsideProjectFolders(folders, input.targetPath, { allowFolderRoot: true });

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProjectFolders(folders, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
