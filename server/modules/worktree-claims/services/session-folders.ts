import path from 'node:path';

import type { SessionFolder, SessionWorktree } from '@/shared/types.js';
import { isPathInsideFolder, isSameFolderPath } from '@/shared/utils.js';

/**
 * Maps project folders onto the checkouts a chat works in. A folder that is a
 * claimed repository takes its checkout; a folder inside one (a package under
 * a Unity project) moves along with it; any other folder stays on main.
 */
export function mapFoldersToSessionWorktrees(folders: string[], worktrees: SessionWorktree[]): SessionFolder[] {
  return folders.map((folder) => {
    for (const worktree of worktrees) {
      for (const checkout of worktree.checkouts) {
        if (isSameFolderPath(checkout.repo, folder)) {
          return { path: checkout.path, mainPath: folder, suffix: worktree.suffix, unitKey: worktree.unitKey };
        }
        if (isPathInsideFolder(checkout.repo, folder)) {
          return { path: path.join(checkout.path, path.relative(checkout.repo, folder)), mainPath: folder, suffix: worktree.suffix, unitKey: worktree.unitKey };
        }
      }
    }
    return { path: folder, mainPath: folder, suffix: '', unitKey: null };
  });
}
