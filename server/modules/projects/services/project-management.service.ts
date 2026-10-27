import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import spawn from 'cross-spawn';

import { appConfigDb, projectsDb, sessionsDb } from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectFolderValidationDependencies,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import {
  AppError,
  getPathComparisonKey,
  isPathInsideFolder,
  isSameFolderPath,
  normalizeProjectPath,
  validateWorkspacePath,
} from '@/shared/utils.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
  additionalFolders?: string[];
};

type UpdateProjectSettingsInput = {
  displayName?: string;
  additionalFolders?: string[];
  /** Only accepted when it names the current primary folder, which cannot be changed. */
  primaryFolder?: string;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (projectPath: string, customName: string | null) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
  validateAdditionalFolders: (primaryFolder: string, folders: string[]) => Promise<string[]>;
  getProjectById: (projectId: string) => ProjectRepositoryRow | null;
  getAdditionalFolderPaths: (projectId: string) => string[];
  replaceAdditionalFolderPaths: (projectId: string, folderPaths: string[]) => void;
  updateProjectSettingsById: (
    projectId: string,
    settings: { customProjectName?: string | null; additionalFolderPaths?: string[] },
  ) => void;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  /** Extra folders only, in order; the primary folder is `fullPath`. */
  additionalFolders: string[];
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessions: [];
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
};

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const MAXIMUM_ADDITIONAL_FOLDERS = 30;

/** A folder the lenient (import) mode dropped, with the error strict mode would have thrown. */
type RejectedAdditionalFolder = {
  folder: string;
  error: AppError;
};

function isGitIgnoring(outerFolder: string, innerFolder: string): Promise<boolean> {
  const relativePath = path.relative(outerFolder, innerFolder).split(path.sep).join('/');
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', outerFolder, 'check-ignore', '-q', '--', relativePath], {
      shell: false,
      stdio: 'ignore',
    });
    // Exit 1 means "not ignored", 128 means `outerFolder` is not a repository;
    // either way no ignore rule covers the inner folder. A git that cannot be
    // started cannot vouch for one either.
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function isExistingDirectory(folderPath: string): Promise<boolean> {
  try {
    return (await fs.stat(folderPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Production folder-validation capabilities, shared by project create, the
 * settings edit and the one-time folder import in this module.
 */
const defaultFolderValidationDependencies: ProjectFolderValidationDependencies = {
  validatePath: validateWorkspacePath,
  isDirectory: isExistingDirectory,
  isIgnoredByGit: isGitIgnoring,
};

function createFolderError(message: string, code: string, folder: string): AppError {
  return new AppError(message, { code, statusCode: 400, details: { folder } });
}

/**
 * Nesting is allowed only when the outer folder's git ignores the inner one:
 * otherwise the inner folder would show twice in the file tree and is already
 * reachable through the outer folder.
 */
async function findNestingConflict(
  candidate: string,
  existingFolders: string[],
  dependencies: ProjectFolderValidationDependencies,
): Promise<string | null> {
  for (const existingFolder of existingFolders) {
    if (isPathInsideFolder(existingFolder, candidate)) {
      if (!(await dependencies.isIgnoredByGit(existingFolder, candidate))) {
        return existingFolder;
      }
    } else if (isPathInsideFolder(candidate, existingFolder)) {
      if (!(await dependencies.isIgnoredByGit(candidate, existingFolder))) {
        return existingFolder;
      }
    }
  }
  return null;
}

async function resolveAdditionalFolder(
  folder: string,
  acceptedFolders: string[],
  dependencies: ProjectFolderValidationDependencies,
): Promise<string> {
  const validation = await dependencies.validatePath(folder);
  if (!validation.valid || !validation.resolvedPath) {
    throw new AppError('Invalid project folder', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: validation.error ?? 'Path validation failed',
    });
  }

  const resolvedFolder = normalizeProjectPath(validation.resolvedPath);
  if (!(await dependencies.isDirectory(resolvedFolder))) {
    throw createFolderError(`Folder does not exist: ${resolvedFolder}`, 'PROJECT_FOLDER_NOT_FOUND', resolvedFolder);
  }

  const resolvedKey = getPathComparisonKey(resolvedFolder);
  if (acceptedFolders.some((acceptedFolder) => getPathComparisonKey(acceptedFolder) === resolvedKey)) {
    throw createFolderError(
      `Folder is already part of the project: ${resolvedFolder}`,
      'PROJECT_FOLDER_DUPLICATE',
      resolvedFolder,
    );
  }

  const conflictingFolder = await findNestingConflict(resolvedFolder, acceptedFolders, dependencies);
  if (conflictingFolder) {
    throw new AppError(
      `Folders are nested and the outer folder's git does not ignore the inner one: ${conflictingFolder} and ${resolvedFolder}`,
      {
        code: 'PROJECT_FOLDERS_NESTED',
        statusCode: 400,
        details: { folder: resolvedFolder, conflictingFolder },
      },
    );
  }

  return resolvedFolder;
}

/**
 * Validates a project's extra folders against its primary folder and each
 * other, and returns them resolved (symlinks followed, normalized), in order.
 *
 * Without `onRejected` the first invalid folder throws an `AppError`
 * (`INVALID_PROJECT_PATH`, `PROJECT_FOLDER_NOT_FOUND`, `PROJECT_FOLDER_DUPLICATE`,
 * `PROJECT_FOLDERS_NESTED`, `PROJECT_FOLDERS_TOO_MANY`). With it, each invalid
 * folder is reported there and left out, and folders past the cap are dropped:
 * that is the one-time import, where stale folders are expected.
 *
 * Exported for the Projects tests; production callers are in this file.
 */
export async function validateAdditionalFolders(
  primaryFolder: string,
  folders: string[],
  dependencies: ProjectFolderValidationDependencies = defaultFolderValidationDependencies,
  onRejected?: (rejection: RejectedAdditionalFolder) => void,
): Promise<string[]> {
  if (!onRejected && folders.length > MAXIMUM_ADDITIONAL_FOLDERS) {
    throw new AppError(`A project can have at most ${MAXIMUM_ADDITIONAL_FOLDERS} additional folders`, {
      code: 'PROJECT_FOLDERS_TOO_MANY',
      statusCode: 400,
      details: { maximum: MAXIMUM_ADDITIONAL_FOLDERS },
    });
  }

  // The primary takes part in the duplicate and nesting checks but is not returned.
  const acceptedFolders = [normalizeProjectPath(primaryFolder)];
  for (const folder of folders) {
    if (acceptedFolders.length - 1 >= MAXIMUM_ADDITIONAL_FOLDERS) {
      break;
    }

    try {
      acceptedFolders.push(await resolveAdditionalFolder(folder, acceptedFolders, dependencies));
    } catch (error) {
      if (onRejected && error instanceof AppError) {
        onRejected({ folder, error });
        continue;
      }
      throw error;
    }
  }

  return acceptedFolders.slice(1);
}

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (projectPath: string, customName: string | null): CreateProjectPathResult =>
    projectsDb.createProjectPath(projectPath, customName),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
  validateAdditionalFolders: (primaryFolder, folders) => validateAdditionalFolders(primaryFolder, folders),
  getProjectById: (projectId) => projectsDb.getProjectById(projectId),
  getAdditionalFolderPaths: (projectId) => projectsDb.getAdditionalFolderPaths(projectId),
  replaceAdditionalFolderPaths: (projectId, folderPaths) =>
    projectsDb.replaceAdditionalFolderPaths(projectId, folderPaths),
  updateProjectSettingsById: (projectId, settings) => projectsDb.updateProjectSettingsById(projectId, settings),
};

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow, additionalFolders: string[]): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    additionalFolders,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    sessions: [],
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  // Validated before anything is created, so a bad folder leaves no project behind.
  const additionalFolders = await dependencies.validateAdditionalFolders(
    resolvedProjectPath,
    input.additionalFolders ?? [],
  );
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(resolvedProjectPath, normalizedCustomName);

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  if (persistedProject.outcome === 'reactivated_archived') {
    // Re-adding an archived folder is a fresh setup: the name and folders the
    // user just chose replace whatever the archived row carried.
    dependencies.updateProjectSettingsById(projectRow.project_id, {
      customProjectName: normalizedCustomName,
      additionalFolderPaths: additionalFolders,
    });
  } else if (additionalFolders.length > 0) {
    dependencies.replaceAdditionalFolderPaths(projectRow.project_id, additionalFolders);
  }

  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(
      { ...projectRow, custom_project_name: normalizedCustomName },
      additionalFolders,
    ),
  };
}

/**
 * Edits a project's name and extra folders (PATCH /api/projects/:projectId).
 *
 * An omitted field is left unchanged; an empty `displayName` clears the custom
 * name. The primary folder is the session key and cwd, so it cannot change:
 * `primaryFolder` is accepted only when it names the current one. Both edits
 * are stored in one transaction after the folders validate.
 */
export async function updateProjectSettings(
  projectId: string,
  input: UpdateProjectSettingsInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<ProjectApiView> {
  const projectRow = dependencies.getProjectById(projectId);
  if (!projectRow) {
    throw new AppError(`Project "${projectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (input.primaryFolder !== undefined && !isSameFolderPath(input.primaryFolder, projectRow.project_path)) {
    throw new AppError('The primary folder of a project cannot be changed', {
      code: 'PROJECT_PRIMARY_FOLDER_IMMUTABLE',
      statusCode: 400,
    });
  }

  const additionalFolderPaths = input.additionalFolders === undefined
    ? undefined
    : await dependencies.validateAdditionalFolders(projectRow.project_path, input.additionalFolders);
  const trimmedDisplayName = input.displayName?.trim();
  const customProjectName = input.displayName === undefined
    ? undefined
    : (trimmedDisplayName ? trimmedDisplayName : null);

  dependencies.updateProjectSettingsById(projectId, { customProjectName, additionalFolderPaths });

  return mapProjectRowToApiView(
    {
      ...projectRow,
      custom_project_name: customProjectName === undefined ? projectRow.custom_project_name : customProjectName,
    },
    dependencies.getAdditionalFolderPaths(projectId),
  );
}

// ---------------------------------------------------------------------------
// One-time import of extra folders from existing Claude chats
// ---------------------------------------------------------------------------

const PROJECT_FOLDERS_IMPORTED_CONFIG_KEY = 'project_folders_imported';

/** Recent sessions tried per project before giving up on finding a usable snapshot. */
const MAXIMUM_TRANSCRIPTS_PER_PROJECT = 5;

type ProjectFoldersImportDependencies = {
  /** Home directory whose `.claude/settings.json` lists folders Claude adds in every project. */
  homeDirectory: string;
  folderValidation: ProjectFolderValidationDependencies;
  log(message: string): void;
};

function readStringArrayField(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

async function readSettingsAdditionalDirectories(settingsPath: string): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return [];
  }

  try {
    const settings = JSON.parse(content) as { permissions?: { additionalDirectories?: unknown } };
    return readStringArrayField(settings.permissions?.additionalDirectories);
  } catch {
    return [];
  }
}

/**
 * Streams a Claude transcript and returns `additionalWorkingDirectories` of the
 * last `environment` snapshot taken while the chat ran in `primaryFolder`, or
 * `null` when there is none. A chat can move its working directory mid-way,
 * and the snapshots after that describe another project's folders.
 */
async function readLastEnvironmentSnapshotFolders(
  transcriptPath: string,
  primaryFolder: string,
): Promise<string[] | null> {
  const primaryKey = getPathComparisonKey(primaryFolder);
  const lineReader = readline.createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lastFolders: string[] | null = null;
  for await (const line of lineReader) {
    // Transcripts run to tens of MB; only snapshot rows are worth parsing.
    if (!line.includes('"type":"environment"')) {
      continue;
    }

    let row: { type?: unknown; attachment?: { type?: unknown; snapshot?: Record<string, unknown> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const snapshot = row.type === 'attachment' && row.attachment?.type === 'environment'
      ? row.attachment.snapshot
      : undefined;
    if (!snapshot) {
      continue;
    }

    const workingDirectory = snapshot.workingDirectory;
    if (typeof workingDirectory === 'string' && getPathComparisonKey(workingDirectory) !== primaryKey) {
      continue;
    }
    lastFolders = readStringArrayField(snapshot.additionalWorkingDirectories);
  }

  return lastFolders;
}

async function findProjectSnapshotFolders(
  primaryFolder: string,
  log: (message: string) => void,
): Promise<string[] | null> {
  const transcriptPaths = sessionsDb.getSessionsByProjectPathIncludingArchived(primaryFolder)
    .filter((session) => session.provider === 'claude' && session.jsonl_path)
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
    .slice(0, MAXIMUM_TRANSCRIPTS_PER_PROJECT)
    .map((session) => session.jsonl_path as string);

  for (const transcriptPath of transcriptPaths) {
    try {
      const folders = await readLastEnvironmentSnapshotFolders(transcriptPath, primaryFolder);
      if (folders) {
        return folders;
      }
    } catch (error) {
      log(`[projects] skipped unreadable transcript ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

/**
 * Gives existing projects the extra folders their latest Claude chat ran with,
 * once: the `project_folders_imported` app_config key marks it done, also on a
 * fresh install with nothing to import.
 *
 * Only projects without extra folders are touched. Folders that
 * `~/.claude/settings.json` adds to every project are dropped (they are not
 * this project's), as are the primary itself, case-insensitive duplicates on
 * Windows, missing folders and nested folders the outer folder's git does not
 * ignore. The primary's own `.claude/settings*.json` folders are kept: they are
 * exactly the folders this project works across, and the file tree and git
 * panel need them even though Claude would load them by itself.
 *
 * Used by the server entrypoint right after the database is initialized, in
 * the background. Only Claude transcripts record their working directories.
 */
export async function importProjectFoldersFromClaudeTranscripts(
  dependencies: ProjectFoldersImportDependencies = {
    homeDirectory: os.homedir(),
    folderValidation: defaultFolderValidationDependencies,
    log: (message) => console.log(message),
  },
): Promise<void> {
  if (appConfigDb.get(PROJECT_FOLDERS_IMPORTED_CONFIG_KEY) !== null) {
    return;
  }

  const userWideFolderKeys = new Set(
    (await readSettingsAdditionalDirectories(path.join(dependencies.homeDirectory, '.claude', 'settings.json')))
      .map(getPathComparisonKey),
  );
  const projectRows = [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()];

  for (const projectRow of projectRows) {
    if (projectsDb.getAdditionalFolderPaths(projectRow.project_id).length > 0) {
      continue;
    }

    const snapshotFolders = await findProjectSnapshotFolders(projectRow.project_path, dependencies.log);
    if (!snapshotFolders) {
      continue;
    }

    // Lenient: the validator drops duplicates, missing and badly nested folders.
    const candidateFolders = snapshotFolders.filter(
      (folder) => !userWideFolderKeys.has(getPathComparisonKey(folder)),
    );
    const folders = await validateAdditionalFolders(
      projectRow.project_path,
      candidateFolders,
      dependencies.folderValidation,
      () => undefined,
    );
    if (folders.length === 0) {
      continue;
    }

    projectsDb.replaceAdditionalFolderPaths(projectRow.project_id, folders);
    dependencies.log(`[projects] imported ${folders.length} folders for ${projectRow.project_path}`);
  }

  appConfigDb.set(PROJECT_FOLDERS_IMPORTED_CONFIG_KEY, new Date().toISOString());
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
