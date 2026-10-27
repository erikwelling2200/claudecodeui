import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { GroupWorktreeJob } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * The find-worktree skill's script owns worktree listing, lock release and
 * worktree creation; the worktree-lock hook shares its library. Calling it
 * keeps one implementation of the suffix and lock rules.
 */
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SCRIPT_PATH = path.join(CLAUDE_HOME, 'skills', 'find-worktree', 'scripts', 'find-worktree.js');
const JOBS_DIR = path.join(CLAUDE_HOME, 'state', 'worktree-locks', 'jobs');

function scriptMissing(): AppError {
  return new AppError(`The find-worktree skill is not installed at ${SCRIPT_PATH}`, {
    code: 'FIND_WORKTREE_MISSING',
    statusCode: 501,
  });
}

/** Runs the script with `args` (plus `--json`) and returns its parsed output. */
export function runFindWorktree(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args, '--json'], { shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', (error) => reject(new AppError(`Failed to run find-worktree: ${error.message}`, { code: 'FIND_WORKTREE_FAILED', statusCode: 500 })));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(stderr.includes('Cannot find module') && stderr.includes('find-worktree') ? scriptMissing()
          : new AppError(stderr.trim() || `find-worktree exited with code ${code}`, { code: 'FIND_WORKTREE_FAILED', statusCode: 400 }));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new AppError('find-worktree printed no JSON', { code: 'FIND_WORKTREE_FAILED', statusCode: 500 }));
      }
    });
  });
}

/**
 * Starts the script detached with `--job <jobId>`, so a worktree creation that
 * copies many GB outlives the request; progress is read with `readFindWorktreeJob`.
 */
export function startFindWorktreeJob(jobId: string, args: string[]): void {
  const child = spawn(process.execPath, [SCRIPT_PATH, ...args, '--job', jobId], {
    shell: false,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** The job's progress file, or null while the script has not written one yet. */
export async function readFindWorktreeJob(jobId: string): Promise<GroupWorktreeJob | null> {
  try {
    return JSON.parse(await readFile(path.join(JOBS_DIR, `${jobId}.json`), 'utf8')) as GroupWorktreeJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
