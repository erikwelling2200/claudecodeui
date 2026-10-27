import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'projects-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('projectsDb.createProjectPath returns created for fresh paths', async () => {
  await withIsolatedDatabase(() => {
    const created = projectsDb.createProjectPath('/workspace/new-project');

    assert.equal(created.outcome, 'created');
    assert.ok(created.project);
    assert.equal(created.project?.project_path, '/workspace/new-project');
    assert.equal(created.project?.isArchived, 0);
  });
});

test('projectsDb.createProjectPath returns reactivated_archived for archived duplicates', async () => {
  await withIsolatedDatabase(() => {
    const initial = projectsDb.createProjectPath('/workspace/archived-project', 'Archived Project');
    assert.equal(initial.outcome, 'created');
    assert.ok(initial.project);

    projectsDb.updateProjectIsArchived('/workspace/archived-project', true);

    const reused = projectsDb.createProjectPath('/workspace/archived-project', 'Renamed Project');
    assert.equal(reused.outcome, 'reactivated_archived');
    assert.ok(reused.project);
    assert.equal(reused.project?.project_id, initial.project?.project_id);
    assert.equal(reused.project?.isArchived, 0);
  });
});

test('projectsDb.createProjectPath returns active_conflict for active duplicates', async () => {
  await withIsolatedDatabase(() => {
    const initial = projectsDb.createProjectPath('/workspace/active-project');
    assert.equal(initial.outcome, 'created');
    assert.ok(initial.project);

    const conflict = projectsDb.createProjectPath('/workspace/active-project');
    assert.equal(conflict.outcome, 'active_conflict');
    assert.ok(conflict.project);
    assert.equal(conflict.project?.project_id, initial.project?.project_id);
    assert.equal(conflict.project?.isArchived, 0);
  });
});

/** A normalized absolute path, so the folder tests hold on Windows and POSIX alike. */
function workspacePath(name: string): string {
  return normalizeProjectPath(path.resolve('/workspace', name));
}

test('projectsDb keeps extra folders per project in their given order', async () => {
  await withIsolatedDatabase(() => {
    const created = projectsDb.createProjectPath(workspacePath('primary'));
    const projectId = created.project?.project_id as string;

    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), []);
    assert.deepEqual(projectsDb.getProjectFolderPathsById(projectId), [workspacePath('primary')]);

    projectsDb.replaceAdditionalFolderPaths(projectId, [workspacePath('zeta'), workspacePath('alpha')]);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), [workspacePath('zeta'), workspacePath('alpha')]);
    assert.deepEqual(
      projectsDb.getProjectFolderPathsById(projectId),
      [workspacePath('primary'), workspacePath('zeta'), workspacePath('alpha')],
    );
    assert.deepEqual(projectsDb.getAdditionalFolderPathsByProjectPath(workspacePath('primary')), [workspacePath('zeta'), workspacePath('alpha')]);
    assert.deepEqual(
      [...projectsDb.listAdditionalFolderPathsByProjectId().entries()],
      [[projectId, [workspacePath('zeta'), workspacePath('alpha')]]],
    );

    projectsDb.replaceAdditionalFolderPaths(projectId, [workspacePath('alpha')]);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), [workspacePath('alpha')]);
    assert.equal(projectsDb.getProjectFolderPathsById('missing-project'), null);
  });
});

test('projectsDb.updateProjectSettingsById changes only the fields it is given', async () => {
  await withIsolatedDatabase(() => {
    const projectId = projectsDb.createProjectPath(workspacePath('settings'), 'Original').project?.project_id as string;
    projectsDb.replaceAdditionalFolderPaths(projectId, [workspacePath('extra')]);

    projectsDb.updateProjectSettingsById(projectId, { customProjectName: 'Renamed' });
    assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'Renamed');
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), [workspacePath('extra')]);

    projectsDb.updateProjectSettingsById(projectId, { additionalFolderPaths: [] });
    assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'Renamed');
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), []);
  });
});

test('deleting a project removes its extra folders with it', async () => {
  await withIsolatedDatabase(() => {
    const projectId = projectsDb.createProjectPath(workspacePath('doomed')).project?.project_id as string;
    projectsDb.replaceAdditionalFolderPaths(projectId, [workspacePath('extra')]);

    projectsDb.deleteProjectById(projectId);
    // A new project on the same path starts clean instead of inheriting rows.
    const recreatedId = projectsDb.createProjectPath(workspacePath('doomed')).project?.project_id as string;
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(projectId), []);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths(recreatedId), []);
    assert.equal(projectsDb.listAdditionalFolderPathsByProjectId().size, 0);
  });
});

test('normalizeProjectPath upper-cases a Windows drive letter', () => {
  assert.equal(normalizeProjectPath('c:\\Unity\\Operatie-OV'), 'C:\\Unity\\Operatie-OV');
  assert.equal(normalizeProjectPath('C:\\Unity\\Operatie-OV\\'), 'C:\\Unity\\Operatie-OV');
});

test('migrations merge projects whose paths differ only in drive-letter case', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const insertProject = db.prepare(
      'INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived) VALUES (?, ?, ?, ?, 0)',
    );
    const insertSession = db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES (?, 'claude', ?)");
    insertProject.run('lower-id', 'c:\\Unity\\Operatie-OV', 'Operatie-OV', 0);
    insertProject.run('upper-id', 'C:\\Unity\\Operatie-OV', 'Operatie-OV', 1);
    insertSession.run('session-1', 'c:\\Unity\\Operatie-OV');
    insertSession.run('session-2', 'c:\\Unity\\Operatie-OV');
    insertSession.run('session-3', 'C:\\Unity\\Operatie-OV');
    projectsDb.replaceAdditionalFolderPaths('upper-id', ['C:\\Unity\\OV-Reizen-Companion']);

    runMigrations(db);

    const projects = db.prepare("SELECT project_id, project_path, isStarred FROM projects WHERE project_path LIKE '%Operatie-OV'").all();
    assert.deepEqual(projects, [{ project_id: 'lower-id', project_path: 'C:\\Unity\\Operatie-OV', isStarred: 1 }]);
    const sessionPaths = db.prepare('SELECT DISTINCT project_path FROM sessions').all();
    assert.deepEqual(sessionPaths, [{ project_path: 'C:\\Unity\\Operatie-OV' }]);
    assert.deepEqual(projectsDb.getAdditionalFolderPaths('lower-id'), ['C:\\Unity\\OV-Reizen-Companion']);
  });
});
