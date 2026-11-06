import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import type { FileSearchResult, FileTreeNode } from '@/shared/types';
import { FILE_TREE_SEARCH_DEBOUNCE_MS, FILE_TREE_SEARCH_LIMIT } from '@/modules/file-tree/constants';
import { buildSearchResultTree, collectDirectoryPaths } from '@/modules/file-tree/utils/fileTreeUtils';

type UseFileTreeSearchArgs = {
  projectId: string | undefined;
  files: FileTreeNode[];
  expandedDirs: Set<string>;
  toggleDirectory: (path: string) => void;
};

type UseFileTreeSearchResult = {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  // The search results as a tree while a query is typed, otherwise the loaded tree.
  filteredFiles: FileTreeNode[];
  // Results open fully on their own; collapsing one there leaves the real tree alone.
  visibleExpandedDirs: Set<string>;
  toggleVisibleDirectory: (path: string) => void;
};

/**
 * Searches the whole project on the server (its file index covers folders the
 * tree has never loaded) and shows the matches laid out as a tree.
 */
export function useFileTreeSearch({
  projectId,
  files,
  expandedDirs,
  toggleDirectory,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  // The latest answer; kept on screen while the next keystroke's search runs.
  const [results, setResults] = useState<FileSearchResult[] | null>(null);
  const [collapsedInResults, setCollapsedInResults] = useState<Set<string>>(() => new Set());
  const query = searchQuery.trim();

  useEffect(() => {
    if (!query || !projectId) {
      setResults(null);
      return;
    }

    const abortController = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await api.searchFiles(
          projectId,
          query,
          { limit: FILE_TREE_SEARCH_LIMIT, type: 'any' },
          { signal: abortController.signal },
        );
        if (!response.ok) {
          throw new Error(`File search failed with ${response.status}`);
        }
        const body = (await response.json()) as { results: FileSearchResult[] };
        if (!abortController.signal.aborted) {
          setResults(body.results);
          setCollapsedInResults(new Set());
        }
      } catch (searchError) {
        if (!abortController.signal.aborted) {
          console.error('Error searching files:', searchError);
          setResults([]);
        }
      }
    }, FILE_TREE_SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [projectId, query]);

  const resultTree = useMemo(
    () => (query && results ? buildSearchResultTree(results, files) : null),
    [files, query, results],
  );

  const visibleExpandedDirs = useMemo(() => {
    if (!resultTree) return expandedDirs;
    return new Set(collectDirectoryPaths(resultTree).filter((directoryPath) => !collapsedInResults.has(directoryPath)));
  }, [collapsedInResults, expandedDirs, resultTree]);

  const toggleVisibleDirectory = useCallback((directoryPath: string) => {
    if (!resultTree) {
      toggleDirectory(directoryPath);
      return;
    }
    setCollapsedInResults((previous) => {
      const next = new Set(previous);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  }, [resultTree, toggleDirectory]);

  return {
    searchQuery,
    setSearchQuery,
    // Until the first answer for a query arrives, the loaded tree stays on screen.
    filteredFiles: resultTree ?? files,
    visibleExpandedDirs,
    toggleVisibleDirectory,
  };
}
