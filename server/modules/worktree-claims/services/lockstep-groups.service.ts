import os from 'node:os';
import path from 'node:path';

import type { LockstepGroup, ProjectLockstepGroups } from '@/shared/types.js';
import {
  AppError,
  getPathComparisonKey,
  readJsonConfig,
  writeJsonConfig,
} from '@/shared/utils.js';

/**
 * Read by the worktree-lock hook and the find-worktree skill in `~/.claude`.
 * Its `groups` hold every project's groups; other keys (`unityMcp`) are edited
 * by hand and preserved on save.
 */
const DEFAULT_GROUPS_FILE = path.join(os.homedir(), '.claude', 'worktree-groups.json');

function readGroupList(config: Record<string, unknown>): LockstepGroup[] {
  const groups = Array.isArray(config.groups) ? config.groups : [];
  return groups
    .filter((group): group is { name: unknown; repos: unknown } => typeof group === 'object' && group !== null)
    .map((group) => ({
      name: String(group.name ?? ''),
      repos: Array.isArray(group.repos) ? group.repos.filter((repo): repo is string => typeof repo === 'string') : [],
    }));
}

/** A group belongs to the project when any of its repos is one of the project's folders. */
function belongsToProject(group: LockstepGroup, folderKeys: Set<string>): boolean {
  return group.repos.some((repo) => folderKeys.has(getPathComparisonKey(repo)));
}

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_LOCKSTEP_GROUPS', statusCode: 400 });
}

/** The lockstep groups that involve any of `folders`. */
export async function readProjectLockstepGroups(
  folders: string[],
  groupsFile: string = DEFAULT_GROUPS_FILE,
): Promise<ProjectLockstepGroups> {
  const folderKeys = new Set(folders.map(getPathComparisonKey));
  const groups = readGroupList(await readJsonConfig(groupsFile));
  return { folders, groups: groups.filter((group) => belongsToProject(group, folderKeys)) };
}

/**
 * Replaces the project's lockstep groups with `groups`, keeping other
 * projects' groups. Each group needs a unique name and at least two of the
 * project's folders, and a folder can be in one group only, across projects
 * too, since the hook resolves a repo to exactly one group.
 */
export async function saveProjectLockstepGroups(
  folders: string[],
  groups: LockstepGroup[],
  groupsFile: string = DEFAULT_GROUPS_FILE,
): Promise<ProjectLockstepGroups> {
  const folderByKey = new Map(folders.map((folder) => [getPathComparisonKey(folder), folder]));
  const config = await readJsonConfig(groupsFile);
  const otherGroups = readGroupList(config).filter((group) => !belongsToProject(group, new Set(folderByKey.keys())));

  const takenNames = new Set(otherGroups.map((group) => group.name));
  const takenRepos = new Map<string, string>();
  for (const group of otherGroups) {
    for (const repo of group.repos) takenRepos.set(getPathComparisonKey(repo), group.name);
  }

  const cleanedGroups = groups.map((group) => {
    const name = group.name.trim();
    if (!name) throw invalid('Every lockstep group needs a name');
    if (takenNames.has(name)) throw invalid(`There is already a lockstep group named "${name}"`);
    takenNames.add(name);

    const repos = group.repos.map((repo) => {
      const folder = folderByKey.get(getPathComparisonKey(repo));
      if (!folder) throw invalid(`"${repo}" is not a folder of this project`);
      const owner = takenRepos.get(getPathComparisonKey(folder));
      if (owner) throw invalid(`"${folder}" is already in lockstep group "${owner}"`);
      takenRepos.set(getPathComparisonKey(folder), name);
      return folder;
    });
    if (repos.length < 2) throw invalid(`Lockstep group "${name}" needs at least two folders`);
    return { name, repos };
  });

  await writeJsonConfig(groupsFile, { ...config, groups: [...otherGroups, ...cleanedGroups] });
  return { folders, groups: cleanedGroups };
}
