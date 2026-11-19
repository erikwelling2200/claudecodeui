import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';
import type { Router } from 'express';

import { createServerRestartService } from './server-restart.service.js';
import { createSystemRouter } from './system.routes.js';
import { createSystemUpdateService } from './system.service.js';

type SystemModuleOptions = {
  appRoot: string;
  installMode: 'git' | 'npm';
  isPlatform: boolean;
  restart: {
    // Set by the autostart loop (CLOUDCLI_SUPERVISED=1): it restarts the server after any exit.
    isSupervised: boolean;
    // Where a self-spawned replacement writes its console output, since it has no terminal.
    replacementLogPath: string;
    // The entrypoint's graceful shutdown, which ends the process.
    shutdown(): Promise<void>;
  };
};

function runShellCommand(
  command: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  onOutput: (output: string) => void,
  onErrorOutput: (errorOutput: string) => void,
): Promise<{ exitCode: number | null; output: string; errorOutput: string }> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn('sh', ['-c', command], {
      cwd: workingDirectory,
      env: environment,
    });
    let output = '';
    let errorOutput = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      onOutput(text);
    });
    childProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      errorOutput += text;
      onErrorOutput(text);
    });
    childProcess.once('error', reject);
    childProcess.once('close', (exitCode) => {
      resolve({ exitCode, output, errorOutput });
    });
  });
}

/**
 * Starts a detached copy of this very process: same node binary, loader flags (tsx or plain) and entry file, same
 * working directory. CLOUDCLI_REPLACES_PID tells the copy to wait for the port instead of failing on it.
 */
function spawnReplacementServer(logPath: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'a');
  try {
    const child = spawnProcess(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      env: { ...process.env, CLOUDCLI_REPLACES_PID: String(process.pid) },
      detached: true,
      stdio: ['ignore', logFile, logFile],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(logFile);
  }
}

/**
 * Builds the authenticated system router for the server entrypoint using the
 * installation details it already resolves for health and startup metadata.
 */
export function createSystemModule(options: SystemModuleOptions): Router {
  const systemUpdateService = createSystemUpdateService({
    appRoot: options.appRoot,
    installMode: options.installMode,
    isPlatform: options.isPlatform,
    homeDirectory: os.homedir(),
    environment: process.env,
    runShellCommand,
    logInfo: (message, detail) => console.log(message, detail ?? ''),
    logError: (message, detail) => console.error(message, detail ?? ''),
  });
  const serverRestartService = createServerRestartService({
    isSupervised: options.restart.isSupervised,
    spawnReplacement: () => spawnReplacementServer(options.restart.replacementLogPath),
    shutdown: options.restart.shutdown,
    logInfo: (message) => console.log('[System]', message),
  });

  return createSystemRouter(systemUpdateService, serverRestartService);
}
