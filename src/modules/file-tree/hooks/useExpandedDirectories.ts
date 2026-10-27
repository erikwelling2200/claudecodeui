import { useCallback, useMemo, useState } from 'react';

type UseExpandedDirectoriesResult = {
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
  expandDirectories: (paths: string[]) => void;
  collapseAll: () => void;
};

/**
 * Tracks which directories of the file tree are open. The top-level folder
 * nodes of a multi-folder project (`projectRootPaths`) start open: they are
 * tracked by what the user collapsed rather than what they opened, so a root
 * that appears after a refresh is open without an effect writing state.
 */
export function useExpandedDirectories(projectRootPaths: string[] = []): UseExpandedDirectoriesResult {
  const [openedDirs, setOpenedDirs] = useState<Set<string>>(() => new Set());
  // Top-level folder nodes the user collapsed; every other root counts as open.
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => new Set());

  const rootKey = projectRootPaths.join('\n');
  const rootPaths = useMemo(() => new Set(rootKey ? rootKey.split('\n') : []), [rootKey]);

  const expandedDirs = useMemo(() => {
    if (rootPaths.size === 0) {
      return openedDirs;
    }
    const next = new Set(openedDirs);
    rootPaths.forEach((rootPath) => {
      if (!collapsedRoots.has(rootPath)) {
        next.add(rootPath);
      }
    });
    return next;
  }, [collapsedRoots, openedDirs, rootPaths]);

  const toggleDirectory = useCallback((path: string) => {
    if (rootPaths.has(path)) {
      setCollapsedRoots((previous) => {
        const next = new Set(previous);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      return;
    }

    setOpenedDirs((previous) => {
      const next = new Set(previous);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }, [rootPaths]);

  const expandDirectories = useCallback((paths: string[]) => {
    if (paths.length === 0) {
      return;
    }

    const roots = paths.filter((path) => rootPaths.has(path));
    if (roots.length > 0) {
      setCollapsedRoots((previous) => {
        const next = new Set(previous);
        roots.forEach((path) => next.delete(path));
        return next;
      });
    }

    setOpenedDirs((previous) => {
      const next = new Set(previous);
      paths.forEach((path) => {
        if (!rootPaths.has(path)) {
          next.add(path);
        }
      });
      return next;
    });
  }, [rootPaths]);

  // Folds every directory back to the top level; the folder nodes of a
  // multi-folder project stay open so their contents remain one click away.
  const collapseAll = useCallback(() => {
    setOpenedDirs(new Set());
    setCollapsedRoots(new Set());
  }, []);

  return {
    expandedDirs,
    toggleDirectory,
    expandDirectories,
    collapseAll,
  };
}

