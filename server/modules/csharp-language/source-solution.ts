import { createHash } from 'node:crypto';
import path from 'node:path';

/** File access the generator needs, injected so tests run against an in-memory tree. */
export type SourceSolutionFileSystem = {
  listDirectory(directoryPath: string): Promise<string[]>;
  /** Every file below the folder, as absolute paths, recursively. */
  listFilesRecursively(directoryPath: string): Promise<string[]>;
  readTextFile(filePath: string): Promise<string>;
  /** Null when the file does not exist. */
  readTextFileIfExists(filePath: string): Promise<string | null>;
  /** Modification time in ms, or null when the file does not exist. */
  getModifiedTime(filePath: string): Promise<number | null>;
  writeTextFile(filePath: string, text: string): Promise<void>;
  createDirectory(directoryPath: string): Promise<void>;
};

export type SourceSolutionOptions = {
  /** Unity project folders whose generated csproj files provide editable source for assemblies other projects consume as DLLs. */
  sourceProjectRoots: string[];
  /** Folder the generated solutions are written under, one subfolder per consuming solution. */
  outputRoot: string;
  fileSystem: SourceSolutionFileSystem;
  now(): number;
  /** How long a prepared solution is trusted before its inputs are checked for changes again. */
  recheckIntervalMs: number;
};

/**
 * The solution Roslyn should load for the Unity `.sln` at `unitySolutionPath`. `linkedSourceRoots` are the source project folders whose
 * code this solution compiles from source, so the language service knows which other files it can answer for.
 * `fingerprint` changes whenever the set of projects in the solution changes.
 */
export type PreparedSolution = {
  unitySolutionPath: string;
  solutionPath: string;
  linkedSourceRoots: string[];
  fingerprint: string;
};

type ProjectFile = {
  directory: string;
  fileName: string;
  text: string;
  assemblyName: string;
  guid: string;
};

type SourceProject = ProjectFile & { sourceRoot: string };

// Bumped whenever the generated output changes shape, so existing caches are rewritten.
const GENERATOR_VERSION = '1';
const CSHARP_PROJECT_TYPE_GUID = '{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}';
const STAMP_FILE_NAME = '.cloudcli-stamp';

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/** True when the file lies inside one of the folders. */
export function isUnderAnyRoot(filePath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root).toLowerCase(), path.resolve(filePath).toLowerCase());
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function readElement(text: string, element: string): string | null {
  return new RegExp(`<${element}>([^<]*)</${element}>`).exec(text)?.[1]?.trim() ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toAbsolute(value: string, baseDirectory: string): string {
  return path.isAbsolute(value) || value.startsWith('$(') ? value : path.join(baseDirectory, value);
}

/**
 * Makes every file path in a Unity csproj absolute, so the copy works from another folder: item `Include`s (except
 * `Reference`, whose Include is an assembly name, and `ProjectReference`, which the generator rewrites) and `HintPath`s.
 */
export function absolutizeProjectPaths(text: string, projectDirectory: string): string {
  return text
    .replace(/<(?!Reference\b|ProjectReference\b)(\w+) Include="([^"]+)"/g, (_match, item: string, include: string) => `<${item} Include="${toAbsolute(include, projectDirectory)}"`)
    .replace(/<HintPath>([^<]+)<\/HintPath>/g, (_match, hintPath: string) => `<HintPath>${toAbsolute(hintPath, projectDirectory)}</HintPath>`);
}

function projectReferenceXml(project: ProjectFile, generatedPath: string, indent: string): string {
  return `${indent}<ProjectReference Include="${generatedPath}">\n${indent}  <Project>${project.guid}</Project>\n${indent}  <Name>${project.assemblyName}</Name>\n${indent}</ProjectReference>`;
}

function dllReferenceXml(assemblyName: string, hintPath: string, indent: string): string {
  return `${indent}<Reference Include="${assemblyName}">\n${indent}  <HintPath>${hintPath}</HintPath>\n${indent}  <Private>False</Private>\n${indent}</Reference>`;
}

// Replaces the whole `<element Include="include">...</element>` block, keeping its indentation.
function replaceItemBlock(text: string, element: 'Reference' | 'ProjectReference', include: string, replacement: (indent: string) => string): string {
  const pattern = new RegExp(`([ \\t]*)<${element} Include="${escapeRegExp(include)}">[\\s\\S]*?</${element}>`);
  return text.replace(pattern, (_match, indent: string) => replacement(indent));
}

// Assemblies referenced as DLLs that Unity compiled, the only kind a source project can stand in for.
function listScriptAssemblyReferences(text: string): string[] {
  return [...text.matchAll(/<Reference Include="([^"]+)">\s*<HintPath>([^<]+)<\/HintPath>/g)]
    .filter((match) => /(^|[\\/])Library[\\/]ScriptAssemblies[\\/]/i.test(match[2]))
    .map((match) => match[1]);
}

function listProjectReferences(text: string): string[] {
  return [...text.matchAll(/<ProjectReference Include="([^"]+)">/g)].map((match) => match[1]);
}

function listCompileItems(text: string): string[] {
  return [...text.matchAll(/<Compile Include="([^"]+)"/g)].map((match) => match[1]);
}

function listAssemblyDefinitions(text: string): string[] {
  return [...text.matchAll(/<None Include="([^"]+\.asmdef)"/g)].map((match) => match[1]);
}

/**
 * Unity writes a csproj's Compile list only when the editor regenerates it in that project, so a package checkout's list
 * misses files added since. Returns the `.cs` files on disk that the project's asmdef folder owns but the list lacks:
 * everything below that folder except subfolders with their own asmdef, and the `~`/dot folders Unity ignores.
 */
export function findMissingSources(projectDirectory: string, compileItems: string[], assemblyDefinitions: string[], filesOnDisk: string[]): string[] {
  const listed = new Set(compileItems.map((item) => path.resolve(projectDirectory, item).toLowerCase()));
  const ownFolder = assemblyDefinitions
    .map((definition) => path.dirname(path.resolve(projectDirectory, definition)))
    .find((folder) => compileItems.some((item) => isUnderAnyRoot(path.resolve(projectDirectory, item), [folder])));
  if (!ownFolder) return [];

  const otherAssemblyFolders = filesOnDisk
    .filter((file) => /\.asm(def|ref)$/i.test(file) && !samePath(path.dirname(file), ownFolder))
    .map((file) => path.dirname(file));
  return filesOnDisk.filter((file) => {
    if (!file.toLowerCase().endsWith('.cs') || listed.has(path.resolve(file).toLowerCase()) || !isUnderAnyRoot(file, [ownFolder])) return false;
    const segments = path.relative(ownFolder, path.dirname(file)).split(path.sep).filter(Boolean);
    return !segments.some((segment) => segment.startsWith('.') || segment.endsWith('~')) && !isUnderAnyRoot(file, otherAssemblyFolders);
  }).sort();
}

function addCompileItems(text: string, files: string[]): string {
  if (files.length === 0) return text;
  const items = files.map((file) => `    <Compile Include="${file}" />`).join('\n');
  return text.replace(/<\/Project>\s*$/, `  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`);
}

/** Writes a Visual Studio solution listing the given projects, all in the Debug|Any CPU configuration. */
export function buildSolutionText(projects: { name: string; projectPath: string; guid: string }[]): string {
  const lines = ['Microsoft Visual Studio Solution File, Format Version 12.00', '# Visual Studio 15'];
  for (const project of projects) {
    lines.push(`Project("${CSHARP_PROJECT_TYPE_GUID}") = "${project.name}", "${project.projectPath}", "${project.guid}"`, 'EndProject');
  }
  lines.push('Global', '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution', '\t\tDebug|Any CPU = Debug|Any CPU', '\tEndGlobalSection');
  lines.push('\tGlobalSection(ProjectConfigurationPlatforms) = postSolution');
  for (const project of projects) {
    lines.push(`\t\t${project.guid}.Debug|Any CPU.ActiveCfg = Debug|Any CPU`, `\t\t${project.guid}.Debug|Any CPU.Build.0 = Debug|Any CPU`);
  }
  lines.push('\tEndGlobalSection', 'EndGlobal', '');
  return lines.join('\r\n');
}

/**
 * Generates, per Unity solution, a copy for the language server in which every DLL reference to an assembly that a
 * source project builds from its own `Assets/` folder becomes a project reference to that source. Go to definition
 * on a package type then lands in the editable package checkout, and find references sees both sides. Unity's own
 * `.sln`/`.csproj` files are only read: Unity rewrites them, so the copies live under `outputRoot`.
 */
export class SourceSolutionGenerator {
  private readonly prepared = new Map<string, { checkedAt: number; result: PreparedSolution }>();

  constructor(private readonly options: SourceSolutionOptions) {}

  /** The solution to load for `unitySolutionPath`: a generated one when it consumes a source project, otherwise itself. */
  async prepare(unitySolutionPath: string): Promise<PreparedSolution> {
    const cached = this.prepared.get(unitySolutionPath);
    if (cached && this.options.now() - cached.checkedAt < this.options.recheckIntervalMs) return cached.result;

    const result = await this.generate(unitySolutionPath);
    this.prepared.set(unitySolutionPath, { checkedAt: this.options.now(), result });
    return result;
  }

  private async readProjects(directory: string): Promise<ProjectFile[]> {
    const { fileSystem } = this.options;
    const fileNames = (await fileSystem.listDirectory(directory)).filter((entry) => entry.toLowerCase().endsWith('.csproj')).sort();
    return Promise.all(fileNames.map(async (fileName) => {
      const text = await fileSystem.readTextFile(path.join(directory, fileName));
      return { directory, fileName, text, assemblyName: readElement(text, 'AssemblyName') ?? fileName.slice(0, -'.csproj'.length), guid: readElement(text, 'ProjectGuid') ?? '' };
    }));
  }

  // Hash of every input's path and modification time, so an unchanged tree is not rewritten.
  private async computeStamp(files: string[]): Promise<string> {
    const hash = createHash('sha256').update(GENERATOR_VERSION);
    for (const filePath of files) hash.update(`${filePath}|${await this.options.fileSystem.getModifiedTime(filePath)}\n`);
    return hash.digest('hex');
  }

  private async generate(unitySolutionPath: string): Promise<PreparedSolution> {
    const unchanged = { unitySolutionPath, solutionPath: unitySolutionPath, linkedSourceRoots: [], fingerprint: '' };
    const consumerRoot = path.dirname(unitySolutionPath);
    const sourceRoots = this.options.sourceProjectRoots.filter((root) => !samePath(root, consumerRoot));
    if (sourceRoots.length === 0) return unchanged;

    const consumerProjects = await this.readProjects(consumerRoot);
    const sourceProjects: SourceProject[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const project of await this.readProjects(sourceRoot)) sourceProjects.push({ ...project, sourceRoot });
    }

    // Only assemblies compiled from the source project's own Assets folder are editable source worth navigating to.
    const editableSources = new Map<string, SourceProject>();
    for (const project of sourceProjects) {
      const compileItems = listCompileItems(project.text);
      if (compileItems.length > 0 && compileItems.every((item) => /^Assets[\\/]/i.test(item)) && !editableSources.has(project.assemblyName)) {
        editableSources.set(project.assemblyName, project);
      }
    }

    const consumedAssemblies = new Set(consumerProjects.flatMap((project) => listScriptAssemblyReferences(project.text)).filter((name) => editableSources.has(name)));
    if (consumedAssemblies.size === 0) return unchanged;

    const consumerHash = createHash('sha256').update(path.resolve(consumerRoot).toLowerCase()).digest('hex').slice(0, 8);
    const outputDirectory = path.join(this.options.outputRoot, `${path.basename(consumerRoot)}-${consumerHash}`);
    const generatedSolutionPath = path.join(outputDirectory, path.basename(unitySolutionPath));
    const consumerByFileName = new Map(consumerProjects.map((project) => [project.fileName.toLowerCase(), project]));
    const findSourceProject = (sourceRoot: string, fileName: string) => sourceProjects.find((candidate) => candidate.sourceRoot === sourceRoot && candidate.fileName.toLowerCase() === fileName.toLowerCase());
    const generatedPathOf = (project: ProjectFile): string => (
      consumerByFileName.get(project.fileName.toLowerCase()) === project
        ? path.join(outputDirectory, project.fileName)
        : path.join(outputDirectory, 'sources', path.basename(project.directory), project.fileName)
    );

    // Source projects to copy: the consumed ones, plus the editable source projects they reference that the consumer lacks.
    const includedSources = new Map<string, SourceProject>();
    const pending = [...consumedAssemblies].map((name) => editableSources.get(name)!);
    while (pending.length > 0) {
      const project = pending.pop()!;
      if (includedSources.has(project.assemblyName)) continue;
      includedSources.set(project.assemblyName, project);
      for (const reference of listProjectReferences(project.text)) {
        if (consumerByFileName.has(reference.toLowerCase())) continue;
        const referenced = findSourceProject(project.sourceRoot, reference);
        if (referenced && editableSources.get(referenced.assemblyName) === referenced) pending.push(referenced);
      }
    }

    const sortedSources = [...includedSources.values()].sort((left, right) => left.assemblyName.localeCompare(right.assemblyName));
    const solutionProjects = [...consumerProjects, ...sortedSources].map((project) => ({ name: project.assemblyName, projectPath: generatedPathOf(project), guid: project.guid }));
    const result = {
      unitySolutionPath,
      solutionPath: generatedSolutionPath,
      linkedSourceRoots: [...new Set(sortedSources.map((project) => project.sourceRoot))],
      fingerprint: createHash('sha256').update(solutionProjects.map((project) => project.projectPath).join('\n')).digest('hex'),
    };

    const inputFiles = [unitySolutionPath, ...[...consumerProjects, ...sourceProjects].map((project) => path.join(project.directory, project.fileName))];
    const stamp = await this.computeStamp(inputFiles);
    const stampPath = path.join(outputDirectory, STAMP_FILE_NAME);
    if (await this.options.fileSystem.readTextFileIfExists(stampPath) === stamp) return result;

    const swapSourceDlls = (originalText: string, text: string): string => listScriptAssemblyReferences(originalText)
      .filter((assemblyName) => includedSources.has(assemblyName))
      .reduce((current, assemblyName) => {
        const source = includedSources.get(assemblyName)!;
        return replaceItemBlock(current, 'Reference', assemblyName, (indent) => projectReferenceXml(source, generatedPathOf(source), indent));
      }, text);

    const outputs = new Map<string, string>();
    for (const project of consumerProjects) {
      let text = absolutizeProjectPaths(project.text, project.directory);
      for (const reference of listProjectReferences(project.text)) {
        text = text.replace(`<ProjectReference Include="${reference}">`, `<ProjectReference Include="${path.join(outputDirectory, reference)}">`);
      }
      outputs.set(generatedPathOf(project), swapSourceDlls(project.text, text));
    }

    for (const project of sortedSources) {
      const assemblyDefinitions = listAssemblyDefinitions(project.text);
      const ownFolders = assemblyDefinitions.map((definition) => path.dirname(path.resolve(project.directory, definition)));
      const filesOnDisk = (await Promise.all(ownFolders.map((folder) => this.options.fileSystem.listFilesRecursively(folder)))).flat();
      const missingSources = findMissingSources(project.directory, listCompileItems(project.text), assemblyDefinitions, filesOnDisk);
      let text = addCompileItems(absolutizeProjectPaths(project.text, project.directory), missingSources);
      for (const reference of listProjectReferences(project.text)) {
        const consumerProject = consumerByFileName.get(reference.toLowerCase());
        const referenced = findSourceProject(project.sourceRoot, reference);
        if (consumerProject) {
          text = replaceItemBlock(text, 'ProjectReference', reference, (indent) => projectReferenceXml(consumerProject, generatedPathOf(consumerProject), indent));
        } else if (referenced && includedSources.get(referenced.assemblyName) === referenced) {
          text = replaceItemBlock(text, 'ProjectReference', reference, (indent) => projectReferenceXml(referenced, generatedPathOf(referenced), indent));
        } else {
          // A dependency that is neither the consumer's own project nor editable source compiles against the DLL Unity built for it.
          const assemblyName = referenced?.assemblyName ?? reference.slice(0, -'.csproj'.length);
          const consumerDll = path.join(consumerRoot, 'Library', 'ScriptAssemblies', `${assemblyName}.dll`);
          const hintPath = await this.options.fileSystem.getModifiedTime(consumerDll) !== null ? consumerDll : path.join(project.sourceRoot, 'Library', 'ScriptAssemblies', `${assemblyName}.dll`);
          text = replaceItemBlock(text, 'ProjectReference', reference, (indent) => dllReferenceXml(assemblyName, hintPath, indent));
        }
      }
      outputs.set(generatedPathOf(project), swapSourceDlls(project.text, text));
    }
    outputs.set(generatedSolutionPath, buildSolutionText(solutionProjects));

    // Only changed files are written, so Roslyn's file watcher reloads just the projects that really changed.
    for (const [outputPath, text] of outputs) {
      if (await this.options.fileSystem.readTextFileIfExists(outputPath) === text) continue;
      await this.options.fileSystem.createDirectory(path.dirname(outputPath));
      await this.options.fileSystem.writeTextFile(outputPath, text);
    }
    await this.options.fileSystem.writeTextFile(stampPath, stamp);
    return result;
  }
}
