import { useCallback, useMemo, useState } from 'react';

import type { ContentSearchFolder, FileTreeNode } from '@/shared/types';

const EXCLUDED_FOLDERS_STORAGE_KEY_PREFIX = 'file-tree-content-search-excluded-folders:';

type StoredExclusions = {
  projectId: string | undefined;
  // Paths of the project folders switched off.
  excludedPaths: string[];
};

type UseContentSearchFoldersResult = {
  // One entry per project folder of a multi-folder project; empty for a single-folder project.
  folders: ContentSearchFolder[];
  // What to send with a search: absent when every folder is searched.
  rootIndexes: number[] | undefined;
  toggleFolder: (folderPath: string) => void;
};

function readExclusions(projectId: string | undefined): StoredExclusions {
  try {
    const stored = projectId ? localStorage.getItem(`${EXCLUDED_FOLDERS_STORAGE_KEY_PREFIX}${projectId}`) : null;
    const parsed: unknown = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      return { projectId, excludedPaths: parsed.filter((entry): entry is string => typeof entry === 'string') };
    }
  } catch {
    // Every folder is searched when storage is unavailable or holds something else.
  }
  return { projectId, excludedPaths: [] };
}

/**
 * Which folders of a multi-folder project a content search covers. The choice
 * is remembered per project as the folders switched off, so a folder added to
 * the project later starts switched on.
 */
export function useContentSearchFolders(projectId: string | undefined, files: FileTreeNode[]): UseContentSearchFoldersResult {
  // The folders switched off for one project; kept in state so a toggle redraws, and reread when the project changes.
  const [exclusions, setExclusions] = useState<StoredExclusions>(() => readExclusions(projectId));
  if (exclusions.projectId !== projectId) {
    setExclusions(readExclusions(projectId));
  }

  const { folders, rootIndexes } = useMemo(() => {
    // The tree's top-level nodes are the project folders, in the project's own order.
    const roots = files.filter((node) => node.isProjectRoot);
    const available: ContentSearchFolder[] = roots.flatMap((node, rootIndex) => (
      // A folder that is gone from disk cannot be searched, so it is neither offered nor sent.
      node.isUnavailable
        ? []
        : [{ path: node.path, name: node.name, rootIndex, selected: !exclusions.excludedPaths.includes(node.path) }]
    ));
    const selected = available.filter((folder) => folder.selected);
    return {
      folders: available,
      rootIndexes: selected.length === roots.length ? undefined : selected.map((folder) => folder.rootIndex),
    };
  }, [exclusions.excludedPaths, files]);

  const toggleFolder = useCallback((folderPath: string) => {
    const excludedPaths = exclusions.excludedPaths.includes(folderPath)
      ? exclusions.excludedPaths.filter((excludedPath) => excludedPath !== folderPath)
      : [...exclusions.excludedPaths, folderPath];
    try {
      if (projectId) {
        localStorage.setItem(`${EXCLUDED_FOLDERS_STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(excludedPaths));
      }
    } catch {
      // The choice still holds for this session when it cannot be stored.
    }
    setExclusions({ projectId, excludedPaths });
  }, [exclusions.excludedPaths, projectId]);

  return { folders, rootIndexes, toggleFolder };
}
