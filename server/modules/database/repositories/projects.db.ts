import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

/** Must run inside a transaction: the delete and the inserts belong together. */
function writeAdditionalFolderPaths(projectId: string, folderPaths: string[]): void {
    const db = getConnection();
    db.prepare('DELETE FROM project_folders WHERE project_id = ?').run(projectId);
    const insert = db.prepare(`
        INSERT INTO project_folders (project_id, folder_path, sort_order)
        VALUES (?, ?, ?)
    `);
    folderPaths.forEach((folderPath, index) => {
        insert.run(projectId, normalizeProjectPath(folderPath), index);
    });
}

export const projectsDb = {
    createProjectPath(projectPath: string, customProjectName: string | null = null): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const attemptedId = randomUUID();
        const row = db.prepare(`
        INSERT INTO projects (project_id, project_path, custom_project_name, isArchived)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(project_path) DO UPDATE SET
            isArchived = 0
            WHERE projects.isArchived = 1
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived
        `).get(attemptedId, normalizedProjectPath, normalizedProjectName) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: row.project_id === attemptedId ? 'created' : 'reactivated_archived',
                project: row,
            };
        }

        const existingProject = projectsDb.getProjectPath(normalizedProjectPath);
        return {
            outcome: 'active_conflict',
            project: existingProject,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     *
     * This is the canonical lookup used after the projectName → projectId migration:
     * API routes receive the DB-assigned `projectId` and must resolve the real folder
     * path through this helper before touching the filesystem. Returns `null` when the
     * project row does not exist so callers can respond with a 404.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Archived rows are queried separately so archive-focused UIs can present
     * hidden workspaces without reintroducing them into the active sidebar list.
     */
    getArchivedProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived
            FROM projects
            WHERE isArchived = 1
        `).all() as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name)
            VALUES (?, ?, ?)
            ON CONFLICT(project_path) DO UPDATE SET custom_project_name = excluded.custom_project_name
        `).run(randomUUID(), normalizedProjectPath, customProjectName);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    /** Extra folders of one project in display order; `[]` for a single-folder project. */
    getAdditionalFolderPaths(projectId: string): string[] {
        const db = getConnection();
        const rows = db.prepare(`
            SELECT folder_path
            FROM project_folders
            WHERE project_id = ?
            ORDER BY sort_order, rowid
        `).all(projectId) as Array<{ folder_path: string }>;

        return rows.map((row) => row.folder_path);
    },

    /**
     * Extra folders of the project whose primary folder is `projectPath`.
     * Chat dispatch only knows a session's `project_path`, not its project id.
     */
    getAdditionalFolderPathsByProjectPath(projectPath: string): string[] {
        const db = getConnection();
        const rows = db.prepare(`
            SELECT project_folders.folder_path
            FROM project_folders
            JOIN projects ON projects.project_id = project_folders.project_id
            WHERE projects.project_path = ?
            ORDER BY project_folders.sort_order, project_folders.rowid
        `).all(normalizeProjectPath(projectPath)) as Array<{ folder_path: string }>;

        return rows.map((row) => row.folder_path);
    },

    /** Every project's extra folders in one query, keyed by project id; projects without any are absent. */
    listAdditionalFolderPathsByProjectId(): Map<string, string[]> {
        const db = getConnection();
        const rows = db.prepare(`
            SELECT project_id, folder_path
            FROM project_folders
            ORDER BY project_id, sort_order, rowid
        `).all() as Array<{ project_id: string; folder_path: string }>;

        const foldersByProjectId = new Map<string, string[]>();
        for (const row of rows) {
            const folders = foldersByProjectId.get(row.project_id);
            if (folders) {
                folders.push(row.folder_path);
            } else {
                foldersByProjectId.set(row.project_id, [row.folder_path]);
            }
        }
        return foldersByProjectId;
    },

    /** `[primary, ...extra]` for a project, or `null` when the project does not exist. */
    getProjectFolderPathsById(projectId: string): string[] | null {
        const primaryPath = projectsDb.getProjectPathById(projectId);
        if (primaryPath === null) {
            return null;
        }
        return [primaryPath, ...projectsDb.getAdditionalFolderPaths(projectId)];
    },

    /** Replaces a project's extra folders with `folderPaths`, keeping their order. */
    replaceAdditionalFolderPaths(projectId: string, folderPaths: string[]): void {
        const db = getConnection();
        const replace = db.transaction(() => {
            writeAdditionalFolderPaths(projectId, folderPaths);
        });
        replace();
    },

    /**
     * Applies a project settings edit atomically. An omitted field is left as
     * it is; `customProjectName: null` clears the custom name.
     */
    updateProjectSettingsById(
        projectId: string,
        settings: { customProjectName?: string | null; additionalFolderPaths?: string[] },
    ): void {
        const db = getConnection();
        const update = db.transaction(() => {
            if (settings.customProjectName !== undefined) {
                projectsDb.updateCustomProjectNameById(projectId, settings.customProjectName);
            }
            if (settings.additionalFolderPaths !== undefined) {
                writeAdditionalFolderPaths(projectId, settings.additionalFolderPaths);
            }
        });
        update();
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },
};
