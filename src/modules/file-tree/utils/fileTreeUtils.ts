import type { TFunction } from 'i18next';

import type { FileSearchResult, FileTreeNode } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

// Node paths come from the server with its own separator, so both count.
export function isInsidePath(parentPath: string, candidatePath: string): boolean {
  if (candidatePath.length <= parentPath.length || !candidatePath.startsWith(parentPath)) return false;
  const separator = candidatePath[parentPath.length];
  return separator === '/' || separator === '\\';
}

export function findTreeNode(nodes: FileTreeNode[], targetPath: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children && isInsidePath(node.path, targetPath)) return findTreeNode(node.children, targetPath);
  }
  return null;
}

/**
 * Keeps contents already loaded below a freshly listed directory: a listing
 * only reaches its requested depth, and must not unload what the user opened
 * deeper down.
 */
function keepLoadedDescendants(fresh: FileTreeNode[], previous: FileTreeNode[] | undefined): FileTreeNode[] {
  if (!previous) return fresh;
  const previousByPath = new Map(previous.map((node) => [node.path, node]));
  return fresh.map((node) => {
    const old = previousByPath.get(node.path);
    if (node.type !== 'directory' || !old?.children) return node;
    return { ...node, children: node.children ? keepLoadedDescendants(node.children, old.children) : old.children };
  });
}

/** Returns a new tree with `directoryPath`'s contents replaced; untouched branches keep their identity. */
export function setDirectoryChildren(nodes: FileTreeNode[], directoryPath: string, children: FileTreeNode[]): FileTreeNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    if (node.path === directoryPath) {
      changed = true;
      return { ...node, children: keepLoadedDescendants(children, node.children) };
    }
    if (node.children && isInsidePath(node.path, directoryPath)) {
      const nextChildren = setDirectoryChildren(node.children, directoryPath, children);
      if (nextChildren !== node.children) {
        changed = true;
        return { ...node, children: nextChildren };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

/**
 * The directories whose contents should be loaded now, each with the depth to
 * load it to: every directory up to `prefetchDepth` levels below the rows on
 * screen. Rows are on screen when every ancestor is expanded.
 */
export function collectDirectoriesToLoad(
  nodes: FileTreeNode[],
  expandedDirs: Set<string>,
  prefetchDepth: number,
): Map<string, number> {
  const toLoad = new Map<string, number>();

  // `distance` is how many levels `levelNodes` lie below the visible rows; 0 means they are visible.
  const visit = (levelNodes: FileTreeNode[], distance: number) => {
    for (const node of levelNodes) {
      if (node.type !== 'directory' || node.isUnavailable) continue;
      const childDistance = distance === 0 && expandedDirs.has(node.path) ? 0 : distance + 1;
      if (childDistance > prefetchDepth) continue;
      if (node.children === undefined) {
        toLoad.set(node.path, prefetchDepth - childDistance + 1);
        continue;
      }
      visit(node.children, childDistance);
    }
  };

  visit(nodes, 0);
  return toLoad;
}

function createSearchNode(name: string, nodePath: string, type: FileTreeNode['type']): FileTreeNode {
  return { name, path: nodePath, type, ...(type === 'directory' ? { children: [] } : {}) };
}

/**
 * Lays search results out as a tree under the loaded top level: under each
 * folder node of a multi-folder project, or at the top for a single folder.
 * A result's ancestors are added as directories so every match sits where it
 * lives.
 */
export function buildSearchResultTree(results: FileSearchResult[], loadedRoots: FileTreeNode[]): FileTreeNode[] {
  const projectRoots = loadedRoots.filter((node) => node.isProjectRoot);
  const topLevel: FileTreeNode[] = projectRoots.map((root) => ({ ...root, children: [] }));
  const nodesByPath = new Map<string, FileTreeNode>(topLevel.map((root) => [root.path, root]));

  for (const result of results) {
    const root = projectRoots.length > 0 ? nodesByPath.get(result.rootPath) : null;
    if (projectRoots.length > 0 && !root) continue;

    // The server's separator, read off the result's own absolute path.
    const separator = result.path.charAt(result.path.length - result.name.length - 1) || '/';
    const segments = result.relativePath.split('/');
    let siblings = root ? root.children! : topLevel;
    let currentPath = result.rootPath;
    segments.forEach((segment, index) => {
      currentPath = `${currentPath}${separator}${segment}`;
      const isLeaf = index === segments.length - 1;
      let node = nodesByPath.get(currentPath);
      if (!node) {
        node = createSearchNode(segment, currentPath, isLeaf ? result.type : 'directory');
        nodesByPath.set(currentPath, node);
        siblings.push(node);
      }
      siblings = node.children ?? [];
    });
  }

  const sortLevel = (nodes: FileTreeNode[]) => {
    nodes.sort((left, right) => (
      left.type !== right.type ? (left.type === 'directory' ? -1 : 1) : left.name.localeCompare(right.name)
    ));
    nodes.forEach((node) => node.children && sortLevel(node.children));
  };
  topLevel.forEach((root) => root.children && sortLevel(root.children));
  if (projectRoots.length === 0) sortLevel(topLevel);
  return topLevel;
}

export function collectDirectoryPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (levelNodes: FileTreeNode[]) => {
    for (const node of levelNodes) {
      if (node.type === 'directory') {
        paths.push(node.path);
        if (node.children) visit(node.children);
      }
    }
  };
  visit(nodes);
  return paths;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}

