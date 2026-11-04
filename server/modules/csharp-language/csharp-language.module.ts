import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCsharpLanguageRouter } from './csharp-language.routes.js';
import { createCsharpLanguageService } from './csharp-language.service.js';
import { RoslynLanguageServer } from './roslyn-language-server.js';
import { SourceSolutionGenerator } from './source-solution.js';
import type { SourceSolutionFileSystem } from './source-solution.js';

// A Roslyn server holds a whole solution in memory (hundreds of MB for a Unity project), so it is not kept forever.
const IDLE_TIMEOUT_MS = 30 * 60_000;

const SERVER_FILE_NAME = process.platform === 'win32' ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer';
const EXTENSION_FOLDERS = ['.vscode', '.vscode-insiders', '.cursor'].map((folder) => path.join(os.homedir(), folder, 'extensions'));

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fsPromises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Uses `ROSLYN_LANGUAGE_SERVER_PATH` when set, and otherwise the server bundled with the newest installed
 * C# extension (`ms-dotnettools.csharp`) of VS Code, VS Code Insiders or Cursor.
 */
async function locateServerExecutable(): Promise<string | null> {
  const configuredPath = process.env.ROSLYN_LANGUAGE_SERVER_PATH;
  if (configuredPath) return configuredPath;

  const candidates: { version: string; executablePath: string }[] = [];
  for (const extensionFolder of EXTENSION_FOLDERS) {
    if (!await pathExists(extensionFolder)) continue;
    for (const entry of await fsPromises.readdir(extensionFolder)) {
      const version = /^ms-dotnettools\.csharp-(\d+(?:\.\d+)*)/.exec(entry)?.[1];
      const executablePath = path.join(extensionFolder, entry, '.roslyn', SERVER_FILE_NAME);
      if (version && await pathExists(executablePath)) candidates.push({ version, executablePath });
    }
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version));
  return candidates[0]?.executablePath ?? null;
}

// Rechecking the Unity csproj files for changes costs a few hundred ms, and the editor polls status every few seconds.
const SOLUTION_RECHECK_MS = 15_000;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Real file access for the source solution generator. */
export const nodeSourceSolutionFileSystem: SourceSolutionFileSystem = {
  listDirectory: (directoryPath) => fsPromises.readdir(directoryPath),
  async listFilesRecursively(directoryPath) {
    if (!await pathExists(directoryPath)) return [];
    const entries = await fsPromises.readdir(directoryPath, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  },
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  async readTextFileIfExists(filePath) {
    try {
      return await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  async getModifiedTime(filePath) {
    try {
      return (await fsPromises.stat(filePath)).mtimeMs;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  },
  writeTextFile: (filePath, text) => fsPromises.writeFile(filePath, text, 'utf8'),
  async createDirectory(directoryPath) {
    await fsPromises.mkdir(directoryPath, { recursive: true });
  },
};

/**
 * `CSHARP_SOURCE_PROJECTS` lists the Unity project folders, separated by `;` (`:` off Windows), that hold the editable
 * source of packages other Unity projects consume as DLLs, such as `C:/Unity/ChangefiedPackages`.
 */
export function readSourceProjectRoots(value: string | undefined): string[] {
  return (value ?? '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean).map((entry) => path.resolve(entry));
}

const sourceSolutionGenerator = new SourceSolutionGenerator({
  sourceProjectRoots: readSourceProjectRoots(process.env.CSHARP_SOURCE_PROJECTS),
  outputRoot: path.join(os.homedir(), '.cloudcli', 'csharp-solutions'),
  fileSystem: nodeSourceSolutionFileSystem,
  now: () => Date.now(),
  recheckIntervalMs: SOLUTION_RECHECK_MS,
});

const csharpLanguageService = createCsharpLanguageService({
  locateServerExecutable,
  listDirectory: (directoryPath) => fsPromises.readdir(directoryPath),
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  prepareSolution: (unitySolutionPath) => sourceSolutionGenerator.prepare(unitySolutionPath),
  createServer: (executablePath, solutionPath) => new RoslynLanguageServer(executablePath, solutionPath),
  now: () => Date.now(),
  idleTimeoutMs: IDLE_TIMEOUT_MS,
});

/** C# language router assembled for the server entrypoint. */
export const csharpLanguageRoutes = createCsharpLanguageRouter(csharpLanguageService);
