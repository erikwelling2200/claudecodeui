import type { FileTreeNode } from '@/shared/types';

// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The paths to expand, root first, so `reference` becomes visible in the file
 * tree; empty when the reference is not inside the loaded tree.
 *
 * Each level is looked up by name in the tree that is already loaded, rather
 * than composed as a string: an in-chat reference is usually relative
 * (`decisions/`, as the model wrote it) while every node is keyed by the
 * absolute path the server built with its own platform separator. Expansion
 * stops at the last level actually present, so a folder hidden by `.gitignore`
 * or below the walk depth still opens as far as the tree goes.
 */
export function directoryRevealPaths(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): string[] {
  const projectRoots = files.filter((node) => node.isProjectRoot);
  if (projectRoots.length > 0) {
    return multiRootRevealPaths(projectRoots, reference);
  }

  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to expand) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return [];
    }
    relative = target.slice(root.length + 1);
  }

  return walkRelativePath(files, relative);
}

// Windows paths compare case-insensitively: transcripts carry both `C:\x` and `c:\x`.
const comparablePath = (value: string): string =>
  (/^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value);

/**
 * A multi-folder project lists one top-level node per folder, primary first.
 * A relative reference lives in the primary folder; an absolute one in the
 * folder that contains it, the deepest one when folders are nested. The folder
 * node itself leads the result so a collapsed folder opens too.
 */
function multiRootRevealPaths(projectRoots: FileTreeNode[], reference: string): string[] {
  const target = normalizePath(reference);

  if (!isAbsolutePath(target)) {
    const primary = projectRoots[0];
    return [primary.path, ...walkRelativePath(primary.children ?? [], target)];
  }

  const comparableTarget = comparablePath(target);
  let owner: FileTreeNode | null = null;
  let ownerRoot = '';
  for (const node of projectRoots) {
    const root = comparablePath(normalizePath(node.path));
    const contains = comparableTarget === root || comparableTarget.startsWith(`${root}/`);
    if (contains && root.length > ownerRoot.length) {
      owner = node;
      ownerRoot = root;
    }
  }

  if (!owner) {
    return [];
  }
  const relative = target.slice(ownerRoot.length + 1);
  return [owner.path, ...walkRelativePath(owner.children ?? [], relative)];
}

// Descends `relative` one segment at a time through the loaded tree and
// returns the directories it passed, stopping at the first missing level.
function walkRelativePath(files: FileTreeNode[], relative: string): string[] {
  const paths: string[] = [];
  let level = files;
  for (const segment of relative.split('/').filter(Boolean)) {
    const directory = level.find((node) => node.type === 'directory' && node.name === segment);
    if (!directory) {
      break;
    }
    paths.push(directory.path);
    level = directory.children ?? [];
  }

  return paths;
}
