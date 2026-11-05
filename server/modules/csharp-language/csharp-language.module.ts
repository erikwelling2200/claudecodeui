import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCsharpLanguageRouter } from './csharp-language.routes.js';
import { createCsharpLanguageService } from './csharp-language.service.js';
import { RoslynInstaller } from './roslyn-installer.js';
import { RoslynLanguageServer } from './roslyn-language-server.js';
import { SourceSolutionGenerator } from './source-solution.js';
import type { SourceSolutionFileSystem } from './source-solution.js';

// A Roslyn server holds a whole solution in memory (hundreds of MB for a Unity project), so it is not kept forever.
const IDLE_TIMEOUT_MS = 30 * 60_000;

const EDITOR_EXTENSION_FOLDERS = ['.vscode', '.vscode-insiders', '.cursor'].map((folder) => path.join(os.homedir(), folder, 'extensions'));

// Rechecking the Unity csproj files for changes costs a few hundred ms, and the editor polls status every few seconds.
const SOLUTION_RECHECK_MS = 15_000;

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fsPromises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

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

const roslynInstaller = new RoslynInstaller({
  configuredPath: process.env.ROSLYN_LANGUAGE_SERVER_PATH,
  installRoot: path.join(os.homedir(), '.cloudcli', 'roslyn'),
  editorExtensionFolders: EDITOR_EXTENSION_FOLDERS,
});

const csharpLanguageService = createCsharpLanguageService({
  locateServerExecutable: async () => (await roslynInstaller.locate())?.executablePath ?? null,
  listDirectory: (directoryPath) => fsPromises.readdir(directoryPath),
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  prepareSolution: (unitySolutionPath) => sourceSolutionGenerator.prepare(unitySolutionPath),
  createServer: (executablePath, solutionPath) => new RoslynLanguageServer(executablePath, solutionPath),
  now: () => Date.now(),
  idleTimeoutMs: IDLE_TIMEOUT_MS,
});

/** C# language router assembled for the server entrypoint. */
export const csharpLanguageRoutes = createCsharpLanguageRouter(csharpLanguageService, roslynInstaller);
