import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import type { CsharpServerInstallServices, CsharpServerInstallStatus } from '@/shared/types.js';

const execFileAsync = promisify(execFile);

// Microsoft's public feed for Visual Studio packages; the C# extension of VS Code downloads its server from it too.
const PACKAGE_FEED_URL = 'https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/flat2';
const SERVER_FILE_NAME = process.platform === 'win32' ? 'Microsoft.CodeAnalysis.LanguageServer.exe' : 'Microsoft.CodeAnalysis.LanguageServer';
const RUNTIME_CONFIG_FILE_NAME = 'Microsoft.CodeAnalysis.LanguageServer.runtimeconfig.json';

type LocatedServer = { source: NonNullable<CsharpServerInstallStatus['source']>; executablePath: string; version: string | null };

type RoslynInstallerOptions = {
  /** `ROSLYN_LANGUAGE_SERVER_PATH`, which wins over every install when set. */
  configuredPath: string | undefined;
  /** Holds one folder per installed version, such as `~/.cloudcli/roslyn/5.4.0-2.26179.14`. */
  installRoot: string;
  /** Extension folders of VS Code-like editors, searched for the C# extension's bundled server. */
  editorExtensionFolders: string[];
};

/** Orders dotted versions with an optional `-` prerelease part, such as `5.4.0-2.26179.14`, numerically. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map(Number);
  const rightParts = right.split(/[.-]/).map(Number);
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

/** The NuGet runtime identifier the server package is published under for this machine, such as `win-x64`. */
function runtimeIdentifier(): string {
  const platform = { win32: 'win', darwin: 'osx', linux: 'linux' }[process.platform as string];
  if (!platform || (process.arch !== 'x64' && process.arch !== 'arm64')) {
    throw new Error(`No Roslyn language server is published for ${process.platform}-${process.arch}`);
  }
  return `${platform}-${process.arch}`;
}

async function readInstalledRuntimeMajors(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('dotnet', ['--list-runtimes'], { windowsHide: true });
    return [...stdout.matchAll(/^Microsoft\.NETCore\.App (\d+)\./gm)].map((match) => Number(match[1]));
  } catch {
    // No `dotnet` on the PATH means no shared runtime either.
    return [];
  }
}

/**
 * Finds the Roslyn language server the C# language service starts, and installs CloudCLI's own copy of it from
 * the NuGet feed so the code editor works without VS Code. Created by the csharp-language composition root.
 */
export class RoslynInstaller implements CsharpServerInstallServices {
  private installing: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(private readonly options: RoslynInstallerOptions) {}

  /** `ROSLYN_LANGUAGE_SERVER_PATH` first, then CloudCLI's own install, then the newest C# extension of VS Code or Cursor. */
  async locate(): Promise<LocatedServer | null> {
    if (this.options.configuredPath) return { source: 'environment', executablePath: this.options.configuredPath, version: null };

    const installed = await this.findNewest(this.options.installRoot, (entry) => entry, (entry) => path.join(this.options.installRoot, entry, SERVER_FILE_NAME));
    if (installed) return { source: 'cloudcli', ...installed };

    for (const extensionFolder of this.options.editorExtensionFolders) {
      const bundled = await this.findNewest(
        extensionFolder,
        (entry) => /^ms-dotnettools\.csharp-(\d+(?:\.\d+)*)/.exec(entry)?.[1] ?? null,
        (entry) => path.join(extensionFolder, entry, '.roslyn', SERVER_FILE_NAME),
      );
      if (bundled) return { source: 'editorExtension', ...bundled };
    }
    return null;
  }

  async getInstallStatus(): Promise<CsharpServerInstallStatus> {
    const located = await this.locate();
    const installed = await this.findNewest(this.options.installRoot, (entry) => entry, (entry) => path.join(this.options.installRoot, entry, SERVER_FILE_NAME));
    return {
      source: located?.source ?? null,
      executablePath: located?.executablePath ?? null,
      installedVersion: installed?.version ?? null,
      missingRuntime: installed ? await this.findMissingRuntime(path.dirname(installed.executablePath)) : null,
      installing: this.installing !== null,
      error: this.lastError,
    };
  }

  async startInstall(): Promise<CsharpServerInstallStatus> {
    if (!this.installing) {
      this.lastError = null;
      this.installing = this.install()
        .catch((error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          this.installing = null;
        });
    }
    return this.getInstallStatus();
  }

  private async install(): Promise<void> {
    const packageId = `microsoft.codeanalysis.languageserver.${runtimeIdentifier()}`;
    const versions = (await this.fetchJson(`${PACKAGE_FEED_URL}/${packageId}/index.json`) as { versions?: string[] }).versions ?? [];
    const version = [...versions].sort(compareVersions).at(-1);
    if (!version) throw new Error(`The package feed lists no versions of ${packageId}`);

    const targetFolder = path.join(this.options.installRoot, version);
    if (await pathExists(path.join(targetFolder, SERVER_FILE_NAME))) return;

    const response = await fetch(`${PACKAGE_FEED_URL}/${packageId}/${version}/${packageId}.${version}.nupkg`);
    if (!response.ok) throw new Error(`Downloading ${packageId} ${version} failed with HTTP ${response.status}`);
    const archive = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));

    const contentPrefix = `content/LanguageServer/${runtimeIdentifier()}/`;
    const entries = Object.values(archive.files).filter((entry) => !entry.dir && entry.name.startsWith(contentPrefix));
    if (!entries.some((entry) => entry.name === `${contentPrefix}${SERVER_FILE_NAME}`)) {
      throw new Error(`${packageId} ${version} does not contain ${contentPrefix}${SERVER_FILE_NAME}`);
    }

    // Extracted next to the target and renamed at the end, so an interrupted install never looks complete.
    const stagingFolder = `${targetFolder}.partial`;
    await fsPromises.rm(stagingFolder, { recursive: true, force: true });
    for (const entry of entries) {
      const outputPath = path.join(stagingFolder, ...entry.name.slice(contentPrefix.length).split('/'));
      await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
      await fsPromises.writeFile(outputPath, await entry.async('nodebuffer'));
    }
    if (process.platform !== 'win32') await fsPromises.chmod(path.join(stagingFolder, SERVER_FILE_NAME), 0o755);
    await fsPromises.rename(stagingFolder, targetFolder);
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    return response.json();
  }

  // The server is framework-dependent: it runs on a shared .NET runtime of at least the major version it was built for.
  private async findMissingRuntime(installFolder: string): Promise<string | null> {
    const runtimeConfig = JSON.parse(await fsPromises.readFile(path.join(installFolder, RUNTIME_CONFIG_FILE_NAME), 'utf8')) as {
      runtimeOptions?: { framework?: { name?: string; version?: string } };
    };
    const framework = runtimeConfig.runtimeOptions?.framework;
    if (!framework?.name || !framework.version) throw new Error(`${RUNTIME_CONFIG_FILE_NAME} in ${installFolder} names no framework`);
    const requiredMajor = Number(framework.version.split('.')[0]);
    const installedMajors = await readInstalledRuntimeMajors();
    return installedMajors.some((major) => major >= requiredMajor) ? null : `.NET ${requiredMajor}`;
  }

  private async findNewest(
    folder: string,
    readVersion: (entry: string) => string | null,
    executableIn: (entry: string) => string,
  ): Promise<{ executablePath: string; version: string } | null> {
    if (!await pathExists(folder)) return null;
    const candidates: { executablePath: string; version: string }[] = [];
    for (const entry of await fsPromises.readdir(folder)) {
      const version = readVersion(entry);
      if (!version || entry.endsWith('.partial')) continue;
      const executablePath = executableIn(entry);
      if (await pathExists(executablePath)) candidates.push({ executablePath, version });
    }
    candidates.sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0] ?? null;
  }
}
