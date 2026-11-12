import { StringDecoder } from 'node:string_decoder';

import { rgPath } from '@vscode/ripgrep';
import { spawn } from 'cross-spawn';

import type { FileTreeContentSearchDependencies } from '@/shared/types.js';

// A rejected pattern is explained in a few lines; anything longer is not worth keeping.
const MAXIMUM_ERROR_OUTPUT_LENGTH = 4000;

/**
 * Runs the bundled ripgrep and streams its output line by line. Used by the
 * File Tree composition root as the production `runRipgrep` of the content
 * search, and by its tests to search a real folder.
 */
export const runRipgrepJson: FileTreeContentSearchDependencies['runRipgrep'] = (folderPath, args, run) => (
  new Promise((resolve, reject) => {
    if (run.signal.aborted) {
      resolve({ exitCode: null, errorOutput: '' });
      return;
    }

    const ripgrep = spawn(rgPath, args, { cwd: folderPath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const kill = (): void => { ripgrep.kill(); };
    run.signal.addEventListener('abort', kill, { once: true });

    // A chunk can end in the middle of a line, or of a multi-byte character.
    const decoder = new StringDecoder('utf8');
    let unfinishedLine = '';
    let errorOutput = '';

    ripgrep.stdout?.on('data', (chunk: Buffer) => {
      const lines = (unfinishedLine + decoder.write(chunk)).split('\n');
      unfinishedLine = lines.pop() ?? '';
      if (lines.length > 0) run.onLines(lines);
    });
    ripgrep.stderr?.on('data', (chunk: Buffer) => {
      if (errorOutput.length < MAXIMUM_ERROR_OUTPUT_LENGTH) errorOutput += chunk.toString('utf8');
    });
    ripgrep.on('error', (error) => {
      run.signal.removeEventListener('abort', kill);
      reject(error);
    });
    ripgrep.on('close', (exitCode) => {
      run.signal.removeEventListener('abort', kill);
      if (unfinishedLine) run.onLines([unfinishedLine]);
      resolve({ exitCode, errorOutput });
    });
  })
);
