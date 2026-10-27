import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { appConfigDb, closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import projectsRouter from '@/modules/projects/projects.routes.js';
import {
  createProject,
  importProjectFoldersFromClaudeTranscripts,
  updateProjectSettings,
  validateAdditionalFolders,
} from '@/modules/projects/services/project-management.service.js';
import type { ProjectFolderValidationDependencies, ProjectRepositoryRow } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

const projectRow = {
  project_id: 'project-1',
  project_path: '/workspace/my-project',
  custom_project_name: 'my-project',
  isStarred: 0,
  isArchived: 0,
};

type ProjectManagementDependencies = NonNullable<Parameters<typeof createProject>[1]>;

/** Dependencies that fail loudly when a test reaches a step it did not set up. */
function createDependencies(overrides: Partial<ProjectManagementDependencies> = {}): ProjectManagementDependencies {
  const unexpected = (name: string) => () => {
    throw new Error(`Unexpected call to ${name}`);
  };
  return {
    validatePath: async (projectPath) => ({ valid: true, resolvedPath: projectPath }),
    ensureWorkspaceDirectory: async () => undefined,
    persistProjectPath: () => ({ outcome: 'created', project: projectRow }),
    getProjectByPath: () => projectRow,
    validateAdditionalFolders: async (_primaryFolder, folders) => folders,
    getProjectById: () => projectRow,
    getAdditionalFolderPaths: () => [],
    replaceAdditionalFolderPaths: unexpected('replaceAdditionalFolderPaths'),
    updateProjectSettingsById: unexpected('updateProjectSettingsById'),
    ...overrides,
  };
}

function assertAppError(code: string, statusCode = 400) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.statusCode, statusCode);
    return true;
  };
}

/** An absolute, normalized path, so the folder tests hold on Windows and POSIX alike. */
function folderPath(...segments: string[]): string {
  return normalizeProjectPath(path.resolve('/workspace', ...segments));
}

/**
 * Folder validation over an imaginary disk: `existing` folders exist, and
 * `ignored` lists [outer, inner] pairs where the outer folder's git ignores the inner one.
 */
function createFolderValidation(
  existing: string[],
  ignored: Array<[string, string]> = [],
): ProjectFolderValidationDependencies {
  const existingKeys = new Set(existing.map((entry) => entry.toLowerCase()));
  const ignoredKeys = new Set(ignored.map(([outer, inner]) => `${outer}>${inner}`.toLowerCase()));
  return {
    validatePath: async (candidate) => (
      candidate.includes('forbidden')
        ? { valid: false, error: 'Cannot use system-critical directories as workspace locations' }
        : { valid: true, resolvedPath: candidate }
    ),
    isDirectory: async (candidate) => existingKeys.has(candidate.toLowerCase()),
    isIgnoredByGit: async (outer, inner) => ignoredKeys.has(`${outer}>${inner}`.toLowerCase()),
  };
}

test('createProject throws when project path is missing', async () => {
  await assert.rejects(
    async () => createProject({ projectPath: '' }),
    assertAppError('PROJECT_PATH_REQUIRED'),
  );
});

test('createProject throws when path validation fails', async () => {
  await assert.rejects(
    async () =>
      createProject(
        { projectPath: '/invalid/path' },
        createDependencies({ validatePath: async () => ({ valid: false, error: 'blocked path' }) }),
      ),
    (error: unknown) => {
      assertAppError('INVALID_PROJECT_PATH')(error);
      assert.equal((error as AppError).details, 'blocked path');
      return true;
    },
  );
});

test('createProject throws conflict when active project path already exists', async () => {
  await assert.rejects(
    async () =>
      createProject(
        { projectPath: '/workspace/my-project' },
        createDependencies({
          validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
          persistProjectPath: () => ({ outcome: 'active_conflict', project: projectRow }),
        }),
      ),
    (error: unknown) => {
      assertAppError('PROJECT_ALREADY_EXISTS', 409)(error);
      assert.equal(
        (error as AppError).details,
        `Project path already exists: ${normalizeProjectPath('/workspace/my-project')}`,
      );
      return true;
    },
  );
});

test('createProject falls back to directory name when custom name is not provided', async () => {
  let capturedCustomName: string | null = null;

  const result = await createProject(
    { projectPath: '/workspace/my-project', customName: '' },
    createDependencies({
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      persistProjectPath: (_projectPath, customName) => {
        capturedCustomName = customName;
        return {
          outcome: 'created',
          project: {
            ...projectRow,
            custom_project_name: customName,
          },
        };
      },
    }),
  );

  assert.equal(capturedCustomName, 'my-project');
  assert.equal(result.outcome, 'created');
  assert.equal(result.project.displayName, 'my-project');
  assert.deepEqual(result.project.additionalFolders, []);
});

test('createProject returns archived reuse outcome when archived row is reused', async () => {
  const settingsUpdates: unknown[] = [];
  const result = await createProject(
    { projectPath: '/workspace/my-project' },
    createDependencies({
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      persistProjectPath: () => ({
        outcome: 'reactivated_archived',
        project: {
          ...projectRow,
          isArchived: 1,
        },
      }),
      updateProjectSettingsById: (_projectId, settings) => {
        settingsUpdates.push(settings);
      },
    }),
  );

  assert.equal(result.outcome, 'reactivated_archived');
  assert.equal(result.project.isArchived, true);
  assert.equal(settingsUpdates.length, 1);
});

test('createProject stores the validated extra folders and returns them', async () => {
  const stored: Array<{ projectId: string; folderPaths: string[] }> = [];
  const validated: Array<{ primaryFolder: string; folders: string[] }> = [];

  const result = await createProject(
    { projectPath: '/workspace/my-project', customName: 'Mine', additionalFolders: ['/workspace/b', '/workspace/a'] },
    createDependencies({
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      validateAdditionalFolders: async (primaryFolder, folders) => {
        validated.push({ primaryFolder, folders });
        return folders.map((folder) => `${folder}-resolved`);
      },
      replaceAdditionalFolderPaths: (projectId, folderPaths) => {
        stored.push({ projectId, folderPaths });
      },
    }),
  );

  assert.deepEqual(validated, [{
    primaryFolder: normalizeProjectPath('/workspace/my-project'),
    folders: ['/workspace/b', '/workspace/a'],
  }]);
  assert.deepEqual(stored, [{ projectId: 'project-1', folderPaths: ['/workspace/b-resolved', '/workspace/a-resolved'] }]);
  assert.deepEqual(result.project.additionalFolders, ['/workspace/b-resolved', '/workspace/a-resolved']);
  assert.equal(result.project.displayName, 'Mine');
});

test('createProject creates nothing when an extra folder is rejected', async () => {
  let created = false;
  await assert.rejects(
    createProject(
      { projectPath: '/workspace/my-project', additionalFolders: ['/workspace/missing'] },
      createDependencies({
        validateAdditionalFolders: async () => {
          throw new AppError('Folder does not exist', { code: 'PROJECT_FOLDER_NOT_FOUND', statusCode: 400 });
        },
        ensureWorkspaceDirectory: async () => {
          created = true;
        },
        persistProjectPath: () => {
          created = true;
          return { outcome: 'created', project: projectRow };
        },
      }),
    ),
    assertAppError('PROJECT_FOLDER_NOT_FOUND'),
  );
  assert.equal(created, false);
});

test('createProject overwrites name and folders when it reactivates an archived project', async () => {
  const settingsUpdates: unknown[] = [];
  const result = await createProject(
    { projectPath: '/workspace/my-project', customName: 'Fresh name', additionalFolders: ['/workspace/extra'] },
    createDependencies({
      validatePath: async () => ({ valid: true, resolvedPath: '/workspace/my-project' }),
      persistProjectPath: () => ({
        outcome: 'reactivated_archived',
        project: { ...projectRow, custom_project_name: 'Old name' },
      }),
      updateProjectSettingsById: (projectId, settings) => {
        settingsUpdates.push({ projectId, settings });
      },
    }),
  );

  assert.deepEqual(settingsUpdates, [{
    projectId: 'project-1',
    settings: { customProjectName: 'Fresh name', additionalFolderPaths: ['/workspace/extra'] },
  }]);
  assert.equal(result.project.displayName, 'Fresh name');
  assert.deepEqual(result.project.additionalFolders, ['/workspace/extra']);
});

test('updateProjectSettings reports a missing project as 404', async () => {
  await assert.rejects(
    updateProjectSettings('missing', { displayName: 'x' }, createDependencies({ getProjectById: () => null })),
    assertAppError('PROJECT_NOT_FOUND', 404),
  );
});

test('updateProjectSettings refuses to move the primary folder', async () => {
  await assert.rejects(
    updateProjectSettings('project-1', { primaryFolder: '/workspace/elsewhere' }, createDependencies()),
    assertAppError('PROJECT_PRIMARY_FOLDER_IMMUTABLE'),
  );
});

test('updateProjectSettings stores name and validated folders together', async () => {
  const settingsUpdates: unknown[] = [];
  let storedFolders: string[] = [];
  const project = await updateProjectSettings(
    'project-1',
    { displayName: '  Renamed  ', additionalFolders: ['/workspace/extra'], primaryFolder: '/workspace/my-project' },
    createDependencies({
      validateAdditionalFolders: async (primaryFolder, folders) => {
        assert.equal(primaryFolder, '/workspace/my-project');
        return folders;
      },
      updateProjectSettingsById: (projectId, settings) => {
        settingsUpdates.push({ projectId, settings });
        storedFolders = settings.additionalFolderPaths ?? storedFolders;
      },
      getAdditionalFolderPaths: () => storedFolders,
    }),
  );

  assert.deepEqual(settingsUpdates, [{
    projectId: 'project-1',
    settings: { customProjectName: 'Renamed', additionalFolderPaths: ['/workspace/extra'] },
  }]);
  assert.equal(project.displayName, 'Renamed');
  assert.equal(project.fullPath, '/workspace/my-project');
  assert.deepEqual(project.additionalFolders, ['/workspace/extra']);
});

test('updateProjectSettings leaves omitted fields alone and clears an empty name', async () => {
  const settingsUpdates: unknown[] = [];
  const project = await updateProjectSettings(
    'project-1',
    { displayName: '   ' },
    createDependencies({
      validateAdditionalFolders: async () => {
        throw new Error('folders were not sent');
      },
      updateProjectSettingsById: (_projectId, settings) => {
        settingsUpdates.push(settings);
      },
      getAdditionalFolderPaths: () => ['/workspace/kept'],
    }),
  );

  assert.deepEqual(settingsUpdates, [{ customProjectName: null, additionalFolderPaths: undefined }]);
  assert.equal(project.customName, null);
  assert.deepEqual(project.additionalFolders, ['/workspace/kept']);
});

test('validateAdditionalFolders returns the resolved folders in their order', async () => {
  const primary = folderPath('primary');
  const folders = [folderPath('zeta'), folderPath('alpha')];
  assert.deepEqual(
    await validateAdditionalFolders(primary, folders, createFolderValidation([primary, ...folders])),
    folders,
  );
});

test('validateAdditionalFolders rejects a missing folder', async () => {
  await assert.rejects(
    validateAdditionalFolders(folderPath('primary'), [folderPath('gone')], createFolderValidation([])),
    assertAppError('PROJECT_FOLDER_NOT_FOUND'),
  );
});

test('validateAdditionalFolders passes on the workspace path error', async () => {
  await assert.rejects(
    validateAdditionalFolders(folderPath('primary'), [folderPath('forbidden')], createFolderValidation([])),
    assertAppError('INVALID_PROJECT_PATH'),
  );
});

test('validateAdditionalFolders rejects the primary and repeated folders', async () => {
  const primary = folderPath('primary');
  const extra = folderPath('extra');
  const validation = createFolderValidation([primary, extra]);

  await assert.rejects(validateAdditionalFolders(primary, [primary], validation), assertAppError('PROJECT_FOLDER_DUPLICATE'));
  await assert.rejects(validateAdditionalFolders(primary, [extra, extra], validation), assertAppError('PROJECT_FOLDER_DUPLICATE'));
});

test('validateAdditionalFolders treats folder case as insignificant on Windows only', async () => {
  const primary = folderPath('primary');
  const extra = folderPath('Extra');
  const otherCase = extra.replace('Extra', 'extra');
  const validation = createFolderValidation([primary, extra, otherCase]);

  if (process.platform === 'win32') {
    await assert.rejects(
      validateAdditionalFolders(primary, [extra, otherCase], validation),
      assertAppError('PROJECT_FOLDER_DUPLICATE'),
    );
  } else {
    assert.deepEqual(await validateAdditionalFolders(primary, [extra, otherCase], validation), [extra, otherCase]);
  }
});

test('validateAdditionalFolders allows a nested folder only when the outer git ignores it', async () => {
  const primary = folderPath('primary');
  const ignoredInner = folderPath('primary', 'Packages', 'Ignored');
  const trackedInner = folderPath('primary', 'src');
  const validation = createFolderValidation([primary, ignoredInner, trackedInner], [[primary, ignoredInner]]);

  assert.deepEqual(await validateAdditionalFolders(primary, [ignoredInner], validation), [ignoredInner]);
  await assert.rejects(validateAdditionalFolders(primary, [trackedInner], validation), assertAppError('PROJECT_FOLDERS_NESTED'));
});

test('validateAdditionalFolders applies the nesting rule when the extra folder contains the primary', async () => {
  const primary = folderPath('outer', 'primary');
  const outer = folderPath('outer');
  await assert.rejects(
    validateAdditionalFolders(primary, [outer], createFolderValidation([primary, outer])),
    assertAppError('PROJECT_FOLDERS_NESTED'),
  );

  const ignoringValidation = createFolderValidation([primary, outer], [[outer, primary]]);
  assert.deepEqual(await validateAdditionalFolders(primary, [outer], ignoringValidation), [outer]);
});

test('validateAdditionalFolders caps a project at 30 extra folders', async () => {
  const primary = folderPath('primary');
  const folders = Array.from({ length: 31 }, (_value, index) => folderPath(`folder-${index}`));
  await assert.rejects(
    validateAdditionalFolders(primary, folders, createFolderValidation([primary, ...folders])),
    assertAppError('PROJECT_FOLDERS_TOO_MANY'),
  );
});

test('validateAdditionalFolders in lenient mode drops and reports invalid folders', async () => {
  const primary = folderPath('primary');
  const kept = folderPath('kept');
  const trackedInner = folderPath('primary', 'src');
  const rejected: string[] = [];
  const folders = await validateAdditionalFolders(
    primary,
    [folderPath('gone'), kept, primary, trackedInner],
    createFolderValidation([primary, kept, trackedInner]),
    ({ error }) => {
      rejected.push(error.code);
    },
  );

  assert.deepEqual(folders, [kept]);
  assert.deepEqual(rejected, ['PROJECT_FOLDER_NOT_FOUND', 'PROJECT_FOLDER_DUPLICATE', 'PROJECT_FOLDERS_NESTED']);
});

// ---------------------------------------------------------------------------
// One-time import from Claude transcripts
// ---------------------------------------------------------------------------

/** The shape Claude writes: a top-level `attachment` row whose attachment is an `environment` snapshot. */
function environmentRow(workingDirectory: string, additionalWorkingDirectories: string[]): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    attachment: {
      type: 'environment',
      snapshot: { workingDirectory, isWorktree: false, isGitRepo: true, additionalWorkingDirectories },
    },
    type: 'attachment',
    uuid: 'environment-row',
    timestamp: '2026-10-27T12:00:00.000Z',
  });
}

type ImportFixture = {
  directory: string;
  homeDirectory: string;
  logs: string[];
  writeTranscript(name: string, rows: string[]): Promise<string>;
};

async function withImportFixture(runTest: (fixture: ImportFixture) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'project-folders-import-'));
  const homeDirectory = path.join(directory, 'home');
  await mkdir(path.join(homeDirectory, '.claude'), { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest({
      directory,
      homeDirectory,
      logs: [],
      async writeTranscript(name, rows) {
        const transcriptPath = path.join(directory, `${name}.jsonl`);
        await writeFile(transcriptPath, `${rows.join('\n')}\n`, 'utf8');
        return transcriptPath;
      },
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function runImport(fixture: ImportFixture, validation: ProjectFolderValidationDependencies): Promise<void> {
  return importProjectFoldersFromClaudeTranscripts({
    homeDirectory: fixture.homeDirectory,
    folderValidation: validation,
    log: (message) => {
      fixture.logs.push(message);
    },
  });
}

function projectIdFor(projectPath: string): string {
  return (projectsDb.getProjectPath(projectPath) as ProjectRepositoryRow).project_id;
}

test('the import takes the last snapshot made in the project folder and cleans it', async () => {
  await withImportFixture(async (fixture) => {
    const primary = folderPath('primary');
    const userWide = folderPath('user-wide');
    const early = folderPath('early');
    const kept = folderPath('kept');
    const ignoredNested = folderPath('kept', 'Packages', 'Ignored');
    const trackedNested = folderPath('kept', 'src');
    const otherProject = folderPath('other-project');
    await writeFile(
      path.join(fixture.homeDirectory, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { additionalDirectories: [userWide] } }),
    );

    const caseVariant = process.platform === 'win32' ? kept.toUpperCase() : kept;
    const transcriptPath = await fixture.writeTranscript('session', [
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      environmentRow(primary, [early]),
      environmentRow(primary, [userWide, primary, kept, caseVariant, ignoredNested, trackedNested, folderPath('gone')]),
      // The chat moved to another folder; this snapshot describes that project, not this one.
      environmentRow(otherProject, [otherProject, early]),
    ]);
    sessionsDb.createSession('session-1', 'claude', primary, 'chat', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', transcriptPath);

    await runImport(fixture, createFolderValidation(
      [primary, userWide, early, kept, ignoredNested, trackedNested, otherProject],
      [[kept, ignoredNested]],
    ));

    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectIdFor(primary)), [kept, ignoredNested]);
    assert.deepEqual(fixture.logs, [`[projects] imported 2 folders for ${primary}`]);
  });
});

test('the import keeps folders the project itself lists in its Claude settings', async () => {
  await withImportFixture(async (fixture) => {
    const primary = normalizeProjectPath(path.join(fixture.directory, 'primary'));
    const projectWide = folderPath('project-wide');
    await mkdir(path.join(primary, '.claude'), { recursive: true });
    await writeFile(
      path.join(primary, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { additionalDirectories: [projectWide] } }),
    );
    const transcriptPath = await fixture.writeTranscript('session', [environmentRow(primary, [projectWide])]);
    sessionsDb.createSession('session-1', 'claude', primary, 'chat', undefined, undefined, transcriptPath);

    await runImport(fixture, createFolderValidation([primary, projectWide]));

    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectIdFor(primary)), [projectWide]);
  });
});

test('the import runs only once', async () => {
  await withImportFixture(async (fixture) => {
    const primary = folderPath('primary');
    const extra = folderPath('extra');
    const transcriptPath = await fixture.writeTranscript('session', [environmentRow(primary, [extra])]);
    sessionsDb.createSession('session-1', 'claude', primary, 'chat', undefined, undefined, transcriptPath);
    const validation = createFolderValidation([primary, extra]);

    await runImport(fixture, validation);
    assert.notEqual(appConfigDb.get('project_folders_imported'), null);
    const projectId = projectIdFor(primary);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), [extra]);

    projectsDb.replaceAdditionalFolderPaths(projectId, []);
    await runImport(fixture, validation);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), []);
  });
});

test('the import marks a fresh install done with nothing to import', async () => {
  await withImportFixture(async (fixture) => {
    await runImport(fixture, createFolderValidation([]));
    assert.notEqual(appConfigDb.get('project_folders_imported'), null);
    assert.deepEqual(fixture.logs, []);
  });
});

test('the import skips an unreadable transcript and leaves configured projects alone', async () => {
  await withImportFixture(async (fixture) => {
    const primary = folderPath('primary');
    const configured = folderPath('configured');
    const extra = folderPath('extra');
    const olderTranscript = await fixture.writeTranscript('older', [environmentRow(primary, [extra])]);
    sessionsDb.createSession('older', 'claude', primary, 'older', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', olderTranscript);
    sessionsDb.createSession(
      'newer', 'claude', primary, 'newer', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z',
      path.join(fixture.directory, 'missing.jsonl'),
    );

    const configuredTranscript = await fixture.writeTranscript('configured', [environmentRow(configured, [extra])]);
    sessionsDb.createSession('configured', 'claude', configured, 'c', undefined, undefined, configuredTranscript);
    const configuredId = projectIdFor(configured);
    projectsDb.replaceAdditionalFolderPaths(configuredId, [folderPath('chosen')]);

    await runImport(fixture, createFolderValidation([primary, configured, extra]));

    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectIdFor(primary)), [extra]);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(configuredId), [folderPath('chosen')]);
    assert.ok(fixture.logs.some((message) => message.includes('skipped unreadable transcript')));
  });
});

// ---------------------------------------------------------------------------
// Route parsing (POST /create-project, PATCH /:projectId)
// ---------------------------------------------------------------------------

async function withProjectsServer(runTest: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error as AppError;
    res.status(appError.statusCode ?? 500).json({ error: { code: appError.code, message: appError.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await runTest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function sendJson(url: string, method: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('create-project rejects additionalFolders that are not a list of paths', async () => {
  await withProjectsServer(async (baseUrl) => {
    for (const additionalFolders of ['/workspace/extra', [42], { path: '/workspace/extra' }]) {
      const response = await sendJson(`${baseUrl}/create-project`, 'POST', { path: '/workspace/project', additionalFolders });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'INVALID_ADDITIONAL_FOLDERS');
    }
  });
});

test('PATCH /:projectId validates its body and answers 404 for an unknown project', async () => {
  await withImportFixture(async () => {
    await withProjectsServer(async (baseUrl) => {
      const badName = await sendJson(`${baseUrl}/some-project`, 'PATCH', { displayName: 5 });
      assert.equal(badName.status, 400);
      assert.equal(badName.body.error.code, 'INVALID_PROJECT_SETTINGS');

      const badFolders = await sendJson(`${baseUrl}/some-project`, 'PATCH', { additionalFolders: 'nope' });
      assert.equal(badFolders.status, 400);
      assert.equal(badFolders.body.error.code, 'INVALID_ADDITIONAL_FOLDERS');

      const missing = await sendJson(`${baseUrl}/some-project`, 'PATCH', { displayName: 'Renamed' });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND');
    });
  });
});

test('PATCH /:projectId renames a project and returns its view', async () => {
  await withImportFixture(async () => {
    const created = projectsDb.createProjectPath(folderPath('patched'));
    const projectId = created.project?.project_id as string;

    await withProjectsServer(async (baseUrl) => {
      const response = await sendJson(`${baseUrl}/${projectId}`, 'PATCH', { displayName: 'Patched name' });
      assert.equal(response.status, 200);
      assert.equal(response.body.success, true);
      assert.equal(response.body.project.projectId, projectId);
      assert.equal(response.body.project.displayName, 'Patched name');
      assert.deepEqual(response.body.project.additionalFolders, []);
    });
  });
});
