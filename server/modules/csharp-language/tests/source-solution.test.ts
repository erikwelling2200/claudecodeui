import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { findMissingSources, SourceSolutionGenerator } from '@/modules/csharp-language/source-solution.js';
import type { SourceSolutionFileSystem } from '@/modules/csharp-language/source-solution.js';

const consumerRoot = path.resolve('/unity/Game');
const sourceRoot = path.resolve('/unity/Packages');
const outputRoot = path.resolve('/cache');
const unitySolution = path.join(consumerRoot, 'Game.sln');

function csproj(assemblyName: string, guid: string, items: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <PropertyGroup>',
    `    <ProjectGuid>${guid}</ProjectGuid>`,
    `    <AssemblyName>${assemblyName}</AssemblyName>`,
    '  </PropertyGroup>',
    '  <ItemGroup>',
    items,
    '  </ItemGroup>',
    '</Project>',
    '',
  ].join('\n');
}

function dllReference(name: string, hintPath: string): string {
  return `    <Reference Include="${name}">\n      <HintPath>${hintPath}</HintPath>\n      <Private>False</Private>\n    </Reference>`;
}

function projectReference(fileName: string, guid: string): string {
  return `    <ProjectReference Include="${fileName}">\n      <Project>${guid}</Project>\n      <Name>${fileName.replace('.csproj', '')}</Name>\n    </ProjectReference>`;
}

/** A Unity consumer project referencing `misc.runtime` as a DLL, and a package project that builds it from source. */
function createTree(): Map<string, string> {
  return new Map([
    [unitySolution, 'Microsoft Visual Studio Solution File'],
    [path.join(consumerRoot, 'Assembly-CSharp.csproj'), csproj('Assembly-CSharp', '{A}', [
      '    <Compile Include="Assets\\Scripts\\Announcement.cs" />',
      dllReference('UnityEngine.CoreModule', 'C:\\Unity\\Editor\\UnityEngine.CoreModule.dll'),
      dllReference('Unity.TextMeshPro', 'Library\\ScriptAssemblies\\Unity.TextMeshPro.dll'),
      dllReference('misc.runtime', 'Library\\ScriptAssemblies\\misc.runtime.dll'),
      projectReference('Assembly-CSharp-firstpass.csproj', '{F}'),
    ].join('\n'))],
    [path.join(consumerRoot, 'Assembly-CSharp-firstpass.csproj'), csproj('Assembly-CSharp-firstpass', '{F}', '    <Compile Include="Assets\\Plugins\\Plugin.cs" />')],
    [path.join(consumerRoot, 'Library', 'ScriptAssemblies', 'vendor.cached.dll'), ''],
    [path.join(sourceRoot, 'Packages.sln'), 'Microsoft Visual Studio Solution File'],
    [path.join(sourceRoot, 'misc.runtime.csproj'), csproj('misc.runtime', '{M}', [
      '    <Compile Include="Assets\\Misc\\Runtime\\PerformanceMonoBehaviour.cs" />',
      '    <None Include="Assets\\Misc\\Runtime\\misc.runtime.asmdef" />',
      dllReference('Sirenix.OdinInspector.Attributes', 'Assets\\Plugins\\Sirenix\\Sirenix.OdinInspector.Attributes.dll'),
      projectReference('webp.csproj', '{W}'),
      projectReference('vendor.cached.csproj', '{V}'),
    ].join('\n'))],
    [path.join(sourceRoot, 'webp.csproj'), csproj('webp', '{W}', '    <Compile Include="Assets\\Misc\\Runtime\\WebP\\WebP.cs" />')],
    [path.join(sourceRoot, 'vendor.cached.csproj'), csproj('vendor.cached', '{V}', '    <Compile Include="Library\\PackageCache\\com.vendor\\Vendor.cs" />')],
    [path.join(sourceRoot, 'Assembly-CSharp.csproj'), csproj('Assembly-CSharp', '{P}', '    <Compile Include="Assets\\Scripts\\Sandbox.cs" />')],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'PerformanceMonoBehaviour.cs'), ''],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'misc.runtime.asmdef'), '{}'],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'Added', 'NetData.cs'), ''],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'WebP', 'WebP.cs'), ''],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'WebP', 'WebP.asmdef'), '{}'],
    [path.join(sourceRoot, 'Assets', 'Misc', 'Runtime', 'Samples~', 'Sample.cs'), ''],
  ]);
}

function createFileSystem(files: Map<string, string>) {
  const modifiedTimes = new Map<string, number>();
  const writes: string[] = [];
  const fileSystem: SourceSolutionFileSystem = {
    async listDirectory(directoryPath) {
      const names = new Set<string>();
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) === directoryPath) names.add(path.basename(filePath));
      }
      return [...names];
    },
    async listFilesRecursively(directoryPath) {
      return [...files.keys()].filter((filePath) => filePath.startsWith(directoryPath + path.sep));
    },
    async readTextFile(filePath) {
      const text = files.get(filePath);
      if (text === undefined) throw new Error(`missing ${filePath}`);
      return text;
    },
    async readTextFileIfExists(filePath) {
      return files.get(filePath) ?? null;
    },
    async getModifiedTime(filePath) {
      return files.has(filePath) ? modifiedTimes.get(filePath) ?? 1 : null;
    },
    async writeTextFile(filePath, text) {
      writes.push(filePath);
      files.set(filePath, text);
    },
    async createDirectory() {},
  };
  return { fileSystem, modifiedTimes, writes };
}

function createGenerator(files: Map<string, string>, sourceProjectRoots = [sourceRoot], clock = { now: 0 }) {
  const { fileSystem, modifiedTimes, writes } = createFileSystem(files);
  const generator = new SourceSolutionGenerator({ sourceProjectRoots, outputRoot, fileSystem, now: () => clock.now, recheckIntervalMs: 1_000 });
  return { generator, modifiedTimes, writes, clock };
}

function generatedFile(files: Map<string, string>, solutionPath: string, ...segments: string[]): string {
  const text = files.get(path.join(path.dirname(solutionPath), ...segments));
  assert.ok(text, `expected ${segments.join('/')} to be generated`);
  return text;
}

test('swaps a DLL that a source project builds for a project reference to its generated copy', async () => {
  const files = createTree();
  const { generator, writes } = createGenerator(files);

  const prepared = await generator.prepare(unitySolution);

  assert.equal(path.dirname(path.dirname(prepared.solutionPath)), outputRoot);
  assert.deepEqual(prepared.linkedSourceRoots, [sourceRoot]);
  const consumer = generatedFile(files, prepared.solutionPath, 'Assembly-CSharp.csproj');
  const miscCopy = path.join(path.dirname(prepared.solutionPath), 'sources', 'Packages', 'misc.runtime.csproj');
  assert.match(consumer, new RegExp(`<ProjectReference Include="${miscCopy.replace(/\\/g, '\\\\')}">\\s*<Project>\\{M\\}</Project>`));
  assert.doesNotMatch(consumer, /<Reference Include="misc\.runtime">/);
  // A DLL no source project builds stays a DLL, now at an absolute path.
  assert.ok(consumer.includes(`<HintPath>${path.join(consumerRoot, 'Library', 'ScriptAssemblies', 'Unity.TextMeshPro.dll')}</HintPath>`));
  assert.ok(consumer.includes(`<Compile Include="${path.join(consumerRoot, 'Assets', 'Scripts', 'Announcement.cs')}" />`));
  assert.ok(consumer.includes(`<ProjectReference Include="${path.join(path.dirname(prepared.solutionPath), 'Assembly-CSharp-firstpass.csproj')}">`));
  assert.ok(writes.every((written) => written.startsWith(outputRoot + path.sep)), 'only the cache folder is written');
});

test('brings in the editable projects a package depends on, and compiles the rest against their DLLs', async () => {
  const files = createTree();
  const { generator } = createGenerator(files);

  const prepared = await generator.prepare(unitySolution);

  const solution = files.get(prepared.solutionPath)!;
  for (const name of ['Assembly-CSharp', 'Assembly-CSharp-firstpass', 'misc.runtime', 'webp']) assert.match(solution, new RegExp(`= "${name}", `));
  assert.doesNotMatch(solution, /vendor\.cached/);
  // The package checkout's own Assembly-CSharp would clash with the consumer's, and nothing references it.
  assert.doesNotMatch(solution, /\{P\}/);

  const misc = generatedFile(files, prepared.solutionPath, 'sources', 'Packages', 'misc.runtime.csproj');
  assert.ok(misc.includes(`<ProjectReference Include="${path.join(path.dirname(prepared.solutionPath), 'sources', 'Packages', 'webp.csproj')}">`));
  assert.ok(misc.includes(`<HintPath>${path.join(consumerRoot, 'Library', 'ScriptAssemblies', 'vendor.cached.dll')}</HintPath>`), 'prefers the DLL the consumer built');
  assert.ok(misc.includes(`<HintPath>${path.join(sourceRoot, 'Assets', 'Plugins', 'Sirenix', 'Sirenix.OdinInspector.Attributes.dll')}</HintPath>`));
});

test('adds source files the stale Compile list misses, but not those of a nested assembly or a ~ folder', async () => {
  const files = createTree();
  const { generator } = createGenerator(files);

  const prepared = await generator.prepare(unitySolution);

  const misc = generatedFile(files, prepared.solutionPath, 'sources', 'Packages', 'misc.runtime.csproj');
  const compiled = [...misc.matchAll(/<Compile Include="([^"]+)"/g)].map((match) => path.relative(sourceRoot, match[1]));
  assert.deepEqual(compiled, [path.join('Assets', 'Misc', 'Runtime', 'PerformanceMonoBehaviour.cs'), path.join('Assets', 'Misc', 'Runtime', 'Added', 'NetData.cs')]);
});

test('findMissingSources ignores asmdefs that own none of the listed files', () => {
  const projectDirectory = path.resolve('/p');
  const missing = findMissingSources(projectDirectory, ['Assets\\B\\Listed.cs'], ['Assets\\A\\a.asmdef', 'Assets\\B\\b.asmdef'], [
    path.join(projectDirectory, 'Assets', 'A', 'Other.cs'),
    path.join(projectDirectory, 'Assets', 'B', 'Listed.cs'),
    path.join(projectDirectory, 'Assets', 'B', 'New.cs'),
    path.join(projectDirectory, 'Assets', 'B', '.hidden', 'Hidden.cs'),
  ]);

  assert.deepEqual(missing, [path.join(projectDirectory, 'Assets', 'B', 'New.cs')]);
});

test('loads the Unity solution itself when nothing it consumes is built by a source project', async () => {
  const files = createTree();
  files.set(path.join(consumerRoot, 'Assembly-CSharp.csproj'), csproj('Assembly-CSharp', '{A}', dllReference('Unity.TextMeshPro', 'Library\\ScriptAssemblies\\Unity.TextMeshPro.dll')));

  assert.deepEqual(await createGenerator(files).generator.prepare(unitySolution), { unitySolutionPath: unitySolution, solutionPath: unitySolution, linkedSourceRoots: [], fingerprint: '' });
  assert.deepEqual(await createGenerator(createTree(), []).generator.prepare(unitySolution), { unitySolutionPath: unitySolution, solutionPath: unitySolution, linkedSourceRoots: [], fingerprint: '' });
  const sourceSolution = path.join(sourceRoot, 'Packages.sln');
  assert.equal((await createGenerator(createTree()).generator.prepare(sourceSolution)).solutionPath, sourceSolution);
});

test('rewrites only the files whose input changed, and only after the recheck interval', async () => {
  const files = createTree();
  const { generator, modifiedTimes, writes, clock } = createGenerator(files);
  const first = await generator.prepare(unitySolution);
  writes.length = 0;

  await generator.prepare(unitySolution);
  clock.now = 5_000;
  await generator.prepare(unitySolution);
  assert.deepEqual(writes, [], 'an unchanged tree is not rewritten');

  const consumerProject = path.join(consumerRoot, 'Assembly-CSharp.csproj');
  files.set(consumerProject, files.get(consumerProject)!.replace('Announcement.cs" />', 'Announcement.cs" />\n    <Compile Include="Assets\\Scripts\\New.cs" />'));
  modifiedTimes.set(consumerProject, 2);
  await generator.prepare(unitySolution);
  assert.deepEqual(writes, [], 'a change inside the recheck interval waits');

  clock.now = 10_000;
  const second = await generator.prepare(unitySolution);
  assert.deepEqual(writes.map((written) => path.basename(written)), ['Assembly-CSharp.csproj', '.cloudcli-stamp']);
  assert.equal(second.fingerprint, first.fingerprint, 'the same projects keep the same fingerprint');
});
