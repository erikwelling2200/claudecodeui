import type { ProjectSortOrder } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

export const readProjectSortOrder = (): ProjectSortOrder => (
  readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name'
);

/** Reads the ids of the projects the user hid from the Projects list. */
export const readHiddenProjectIds = (): string[] => {
  const stored = readUserPreference<unknown>('hiddenProjectIds', []);
  return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string') : [];
};

/** Stores the hidden project ids; the preference store syncs them to the server. */
export const writeHiddenProjectIds = (projectIds: string[]) => {
  writeUserPreference('hiddenProjectIds', projectIds);
};

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};
