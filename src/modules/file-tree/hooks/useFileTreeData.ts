import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project, FileTreeNode } from '@/shared/types';
import { FILE_TREE_PREFETCH_DEPTH } from '@/modules/file-tree/constants';
import { collectDirectoriesToLoad, setDirectoryChildren } from '@/modules/file-tree/utils/fileTreeUtils';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  // True only until the first listing of a project arrives; a refresh keeps the tree on screen.
  loading: boolean;
  error: string | null;
  /** Reloads the top level and every loaded directory, in one round trip. */
  refreshFiles: () => void;
  /** Loads the contents of directories already in the tree, `depth` levels deep. */
  loadDirectories: (paths: string[], depth: number) => Promise<void>;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The visible top level plus the levels loaded ahead of it.
const INITIAL_DEPTH = 1 + FILE_TREE_PREFETCH_DEPTH;

// The API reports refusals as { error: message }. Surfacing that message tells
// the user why the tree is missing and what to do about it, instead of leaving
// them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

async function fetchChildren(
  projectId: string,
  paths: string[],
  depth: number,
  signal: AbortSignal,
): Promise<Record<string, FileTreeNode[]>> {
  const response = await api.getFileChildren(projectId, paths, depth, { signal });
  if (!response.ok) {
    throw new Error(`Loading ${paths.length} directories failed with ${response.status}`);
  }
  return (await response.json()) as Record<string, FileTreeNode[]>;
}

function applyListings(tree: FileTreeNode[], listings: Record<string, FileTreeNode[]>): FileTreeNode[] {
  // Shallowest first, so a parent's fresh listing never overwrites its child's.
  return Object.keys(listings)
    .sort((left, right) => left.length - right.length)
    .reduce((next, directoryPath) => setDirectoryChildren(next, directoryPath, listings[directoryPath]), tree);
}

// Directories whose contents are in the tree, so a refresh reloads exactly what is loaded.
function collectLoadedDirectories(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (levelNodes: FileTreeNode[]) => {
    for (const node of levelNodes) {
      if (node.type === 'directory' && node.children && !node.isUnavailable) {
        paths.push(node.path);
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return paths;
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // Read by a refresh to know which directories to reload with the top level.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  // Aborted on a project switch, so a late listing never lands in another project's tree.
  const projectAbortRef = useRef<AbortController | null>(null);
  const projectId = selectedProject?.projectId;

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    setFiles([]);
    setError(null);
    if (!projectId) {
      projectAbortRef.current = null;
      setLoading(false);
      return;
    }
    const abortController = new AbortController();
    projectAbortRef.current = abortController;
    setLoading(true);
    return () => abortController.abort();
  }, [projectId]);

  useEffect(() => {
    const signal = projectAbortRef.current?.signal;
    if (!projectId || !signal) {
      return;
    }
    // On a refresh, every loaded directory is listed again alongside the top level.
    const loadedDirectories = refreshKey > 0 ? collectLoadedDirectories(filesRef.current) : [];

    const fetchFiles = async () => {
      try {
        const [response, listings] = await Promise.all([
          api.getFiles(projectId, INITIAL_DEPTH, { signal }),
          loadedDirectories.length > 0 ? fetchChildren(projectId, loadedDirectories, 1, signal) : Promise.resolve({}),
        ]);

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (!signal.aborted) {
            setFiles([]);
            setError(readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR);
          }
          return;
        }

        const topLevel = (await response.json()) as FileTreeNode[];
        if (!signal.aborted) {
          setFiles(applyListings(topLevel, listings));
          setError(null);
        }
      } catch (fetchError) {
        if (signal.aborted) {
          return;
        }
        console.error('Error fetching files:', fetchError);
        setFiles([]);
        setError(DEFAULT_LOAD_ERROR);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();
  }, [projectId, refreshKey]);

  const loadDirectories = useCallback(async (paths: string[], depth: number) => {
    const signal = projectAbortRef.current?.signal;
    if (!projectId || !signal || paths.length === 0) {
      return;
    }
    const listings = await fetchChildren(projectId, paths, depth, signal);
    if (!signal.aborted) {
      setFiles((previous) => applyListings(previous, listings));
    }
  }, [projectId]);

  return {
    files,
    loading,
    error,
    refreshFiles,
    loadDirectories,
  };
}

/**
 * Keeps every directory up to FILE_TREE_PREFETCH_DEPTH levels below the rows
 * on screen loaded, so expanding a folder shows its contents without a wait.
 * Each pass sends one request per depth for whatever is missing.
 */
export function useDirectoryPrefetch(
  files: FileTreeNode[],
  expandedDirs: Set<string>,
  loadDirectories: (paths: string[], depth: number) => Promise<void>,
): void {
  // Directories requested and not yet answered, so a re-render does not ask twice.
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    const inFlight = inFlightRef.current;
    const byDepth = new Map<number, string[]>();
    collectDirectoriesToLoad(files, expandedDirs, FILE_TREE_PREFETCH_DEPTH).forEach((depth, directoryPath) => {
      if (inFlight.has(directoryPath)) return;
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), directoryPath]);
    });

    byDepth.forEach((paths, depth) => {
      paths.forEach((directoryPath) => inFlight.add(directoryPath));
      loadDirectories(paths, depth)
        .catch((loadError: unknown) => {
          if ((loadError as { name?: string }).name !== 'AbortError') {
            console.error('Error loading directories:', loadError);
          }
        })
        .finally(() => paths.forEach((directoryPath) => inFlight.delete(directoryPath)));
    });
  }, [files, expandedDirs, loadDirectories]);
}
