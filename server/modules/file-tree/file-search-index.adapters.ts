import fs from 'node:fs';

import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'cross-spawn';

import type { FileTreeFileIndexDependencies } from '@/shared/types.js';

/**
 * Lists a folder's files with ripgrep, which honours every `.gitignore` in the
 * tree (not only the root one) and walks in parallel: about half a second for
 * a large Unity project.
 */
export const listFilesWithRipgrep: FileTreeFileIndexDependencies['listFiles'] = (folderPath) => (
  new Promise((resolve, reject) => {
    const args = [
      '--files', '--hidden', '--no-require-git', '--no-messages', '--null', '--path-separator', '/',
      '--glob', '!.git', '--glob', '!node_modules', '--glob', '!.svn', '--glob', '!.hg',
    ];
    const ripgrep = spawn(rgPath, args, { cwd: folderPath, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    ripgrep.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    ripgrep.on('error', reject);
    ripgrep.on('close', (code) => {
      // 1: nothing to list. 2: some paths were unreadable, the rest is still listed.
      if (code !== 0 && code !== 1 && code !== 2) {
        reject(new Error(`ripgrep exited with code ${code} listing "${folderPath}"`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean));
    });
  })
);

/** One native recursive watcher per folder; on Windows and macOS this is a single OS handle. */
export const watchFolderRecursively: FileTreeFileIndexDependencies['watchFolder'] = (folderPath, onChange, onError) => {
  const watcher = fs.watch(folderPath, { recursive: true, persistent: false }, (_event, fileName) => {
    onChange(fileName ? fileName.toString() : null);
  });
  watcher.on('error', () => {
    watcher.close();
    onError();
  });
  return () => watcher.close();
};
