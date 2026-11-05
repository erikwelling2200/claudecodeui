import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createCsharpLanguageService } from '@/modules/csharp-language/csharp-language.service.js';
import type { PreparedSolution } from '@/modules/csharp-language/source-solution.js';
import type { ICsharpLanguageServer } from '@/shared/interfaces.js';
import type { CsharpDocumentRequest, CsharpLanguageServerState } from '@/shared/types.js';

const root = path.resolve('/repo');
const filePath = path.join(root, 'Assets', 'Scripts', 'Player.cs');

class FakeServer implements ICsharpLanguageServer {
  state: CsharpLanguageServerState = 'ready';
  readonly synced: CsharpDocumentRequest[] = [];
  readonly requests: { method: string; params: unknown }[] = [];
  disposed = false;

  constructor(readonly solutionPath: string, private readonly answers: Record<string, unknown> = {}) {}

  getStatus() {
    return { state: this.state, solutionPath: this.solutionPath, message: null, semanticRevision: 0 };
  }

  getSemanticTokenTypes() {
    return ['namespace', 'class', 'method', 'parameter'];
  }

  syncDocument(document: CsharpDocumentRequest) {
    this.synced.push(document);
  }

  async request(method: string, params: unknown) {
    this.requests.push({ method, params });
    return this.answers[method] ?? null;
  }

  dispose() {
    this.disposed = true;
  }
}

function createService(
  directories: Record<string, string[]>,
  answers: Record<string, unknown> = {},
  files: Record<string, string> = {},
  prepared: Record<string, PreparedSolution> = {},
) {
  const servers: FakeServer[] = [];
  const service = createCsharpLanguageService({
    locateServerExecutable: async () => 'roslyn.exe',
    listDirectory: async (directoryPath) => directories[directoryPath] ?? [],
    readTextFile: async (readPath) => {
      if (!(readPath in files)) throw new Error(`unexpected read of ${readPath}`);
      return files[readPath];
    },
    prepareSolution: async (unitySolutionPath) => prepared[unitySolutionPath] ?? { unitySolutionPath, solutionPath: unitySolutionPath, linkedSourceRoots: [], fingerprint: '' },
    createServer: (_executablePath, solutionPath) => {
      const server = new FakeServer(solutionPath, answers);
      servers.push(server);
      return server;
    },
    now: () => 0,
    idleTimeoutMs: 60_000,
  });
  return { service, servers };
}

test('loads the nearest solution above the file and prefers the one named after its folder', async () => {
  const { service } = createService({ [root]: ['Other.sln', 'repo.sln', 'repo.slnx', 'Assets'] });

  const status = await service.getStatus(filePath);

  assert.equal(status.state, 'ready');
  assert.equal(status.solutionPath, path.join(root, 'repo.sln'));
});

test('reports unavailable when no folder above the file holds a solution', async () => {
  const { service, servers } = createService({});

  const status = await service.getStatus(filePath);

  assert.equal(status.state, 'unavailable');
  assert.equal(servers.length, 0);
});

test('reuses one server per solution across files', async () => {
  const { service, servers } = createService({ [root]: ['repo.sln'] });

  await service.getStatus(filePath);
  await service.getStatus(path.join(root, 'Assets', 'Other.cs'));

  assert.equal(servers.length, 1);
});

test('answers semantic requests with the status only while the solution is still loading', async () => {
  const { service, servers } = createService({ [root]: ['repo.sln'] });
  await service.getStatus(filePath);
  servers[0].state = 'loading';

  const tokens = await service.getSemanticTokens({ filePath, text: 'class Player {}' });

  assert.equal(tokens.status.state, 'loading');
  assert.equal(tokens.result, null);
  assert.equal(servers[0].requests.length, 0);
});

test('decodes relative semantic tokens into absolute positions with type names', async () => {
  const { service, servers } = createService({ [root]: ['repo.sln'] }, {
    // `Player` at 0:6, `Move` at 2:9 and its parameter at 2:14.
    'textDocument/semanticTokens/full': { data: [0, 6, 6, 1, 0, 2, 9, 4, 2, 0, 0, 5, 5, 3, 0] },
  });

  const tokens = await service.getSemanticTokens({ filePath, text: 'class Player {' });

  assert.deepEqual(servers[0].synced, [{ filePath, text: 'class Player {' }]);
  assert.deepEqual(tokens.result, [
    { line: 0, character: 6, length: 6, type: 'class' },
    { line: 2, character: 9, length: 4, type: 'method' },
    { line: 2, character: 14, length: 5, type: 'parameter' },
  ]);
});

test('maps definitions to files with a preview line, using the editor text for the open file', async () => {
  const otherFile = path.join(root, 'Assets', 'Scripts', 'Health.cs');
  const { service } = createService({ [root]: ['repo.sln'] }, {
    'textDocument/definition': [
      { uri: pathToFileURL(otherFile).href, range: { start: { line: 1, character: 17 } } },
      { uri: pathToFileURL(filePath).href, range: { start: { line: 0, character: 6 } } },
      { uri: 'roslyn-source-generated://Generated.cs', range: { start: { line: 0, character: 0 } } },
    ],
  }, { [otherFile]: 'namespace Game {\r\n    public class Health { }\r\n}' });

  const definition = await service.findDefinition({ filePath, text: 'class Player { Health health; }', line: 0, character: 16 });

  assert.deepEqual(definition.result, [
    { filePath: otherFile, line: 1, character: 17, preview: 'public class Health { }', access: null },
    { filePath, line: 0, character: 6, preview: 'class Player { Health health; }', access: null },
  ]);
});

test('reports unavailable when no Roslyn install is found', async () => {
  const service = createCsharpLanguageService({
    locateServerExecutable: async () => null,
    listDirectory: async () => ['repo.sln'],
    readTextFile: async () => '',
    prepareSolution: async (unitySolutionPath) => ({ unitySolutionPath, solutionPath: unitySolutionPath, linkedSourceRoots: [], fingerprint: '' }),
    createServer: () => {
      throw new Error('should not start a server');
    },
    now: () => 0,
    idleTimeoutMs: 60_000,
  });

  const status = await service.getStatus(filePath);

  assert.equal(status.state, 'unavailable');
  assert.match(status.message ?? '', /ROSLYN_LANGUAGE_SERVER_PATH/);
});

const packageRoot = path.resolve('/packages');
const packageFile = path.join(packageRoot, 'Assets', 'Runtime', 'PerformanceMonoBehaviour.cs');
const generatedSolution = path.resolve('/cache/repo/repo.sln');

test('loads the prepared solution in place of the Unity one', async () => {
  const { service, servers } = createService({ [root]: ['repo.sln'] }, {}, {}, {
    [path.join(root, 'repo.sln')]: { unitySolutionPath: path.join(root, 'repo.sln'), solutionPath: generatedSolution, linkedSourceRoots: [packageRoot], fingerprint: 'a' },
  });

  const status = await service.getStatus(filePath);

  assert.equal(status.solutionPath, generatedSolution);
  assert.deepEqual(servers.map((server) => server.solutionPath), [generatedSolution]);
});

test('restarts a server whose prepared solution gained or lost projects', async () => {
  const prepared = { [path.join(root, 'repo.sln')]: { unitySolutionPath: path.join(root, 'repo.sln'), solutionPath: generatedSolution, linkedSourceRoots: [packageRoot], fingerprint: 'a' } };
  const { service, servers } = createService({ [root]: ['repo.sln'] }, {}, {}, prepared);
  await service.getStatus(filePath);

  await service.getStatus(filePath);
  prepared[path.join(root, 'repo.sln')] = { ...prepared[path.join(root, 'repo.sln')], fingerprint: 'b' };
  await service.getStatus(filePath);

  assert.equal(servers.length, 2);
  assert.equal(servers[0].disposed, true);
  assert.equal(servers[1].disposed, false);
});

test('lists references from every loaded solution that compiles a package file, without duplicates', async () => {
  const consumerUsage = path.join(root, 'Assets', 'Scripts', 'Announcement.cs');
  const declaration = { uri: pathToFileURL(packageFile).href, range: { start: { line: 3, character: 22 } } };
  const { service, servers } = createService(
    { [root]: ['repo.sln'], [packageRoot]: ['packages.sln'] },
    {},
    { [consumerUsage]: 'public abstract class Announcement : PerformanceMonoBehaviour {' },
    { [path.join(root, 'repo.sln')]: { unitySolutionPath: path.join(root, 'repo.sln'), solutionPath: generatedSolution, linkedSourceRoots: [packageRoot], fingerprint: 'a' } },
  );
  // The package checkout's own solution is loaded first, so both solutions are running.
  await service.getStatus(packageFile);
  await service.getStatus(filePath);
  const packageText = 'using UnityEngine;\n\n\npublic abstract class PerformanceMonoBehaviour : MonoBehaviour {';
  const [packageServer, consumerServer] = servers;
  packageServer.request = async (method, params) => {
    packageServer.requests.push({ method, params });
    return [declaration];
  };
  consumerServer.request = async (method, params) => {
    consumerServer.requests.push({ method, params });
    return [declaration, { uri: pathToFileURL(consumerUsage).href, range: { start: { line: 0, character: 37 } } }];
  };

  const references = await service.findReferences({ filePath: packageFile, text: packageText, line: 3, character: 30 });

  assert.deepEqual(references.result?.map((location) => [location.filePath, location.line]), [
    [packageFile, 3],
    [consumerUsage, 0],
  ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  assert.equal(consumerServer.synced.at(-1)?.text, packageText);
});

test('marks each reference as a read or a write from the document highlights of its file', async () => {
  const usage = path.join(root, 'Assets', 'Scripts', 'Spawner.cs');
  const fileUri = pathToFileURL(filePath).href;
  const usageUri = pathToFileURL(usage).href;
  const at = (line: number, character: number) => ({ start: { line, character } });
  const { service, servers } = createService({ [root]: ['repo.sln'] }, {}, { [usage]: 'health = 3;\nvar left = health;' });
  await service.getStatus(filePath);
  const [server] = servers;
  server.request = async (method, params) => {
    server.requests.push({ method, params });
    if (method === 'textDocument/references') {
      return [{ uri: fileUri, range: at(0, 4) }, { uri: usageUri, range: at(0, 0) }, { uri: usageUri, range: at(1, 11) }];
    }
    const { uri } = (params as { textDocument: { uri: string } }).textDocument;
    // A declaration Roslyn calls a plain text highlight stays unclassified.
    return uri === usageUri ? [{ range: at(0, 0), kind: 3 }, { range: at(1, 11), kind: 2 }] : [{ range: at(0, 4), kind: 1 }];
  };

  const references = await service.findReferences({ filePath, text: 'int health;', line: 0, character: 4 });

  assert.deepEqual(references.result?.map((location) => [location.filePath, location.line, location.access]), [
    [filePath, 0, null],
    [usage, 0, 'write'],
    [usage, 1, 'read'],
  ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  assert.equal(server.requests.filter((request) => request.method === 'textDocument/documentHighlight').length, 2);
});

test('does not ask a solution that does not compile the file', async () => {
  const { service, servers } = createService(
    { [root]: ['repo.sln'], [packageRoot]: ['packages.sln'] },
    { 'textDocument/references': [] },
  );
  await service.getStatus(filePath);
  await service.getStatus(packageFile);

  await service.findReferences({ filePath: packageFile, text: '', line: 0, character: 0 });

  assert.equal(servers[0].requests.length, 0);
  assert.equal(servers[1].requests.length, 1);
});

test('answers a package file from a loaded solution that already compiles it', async () => {
  const { service, servers } = createService({ [root]: ['repo.sln'], [packageRoot]: ['packages.sln'] }, {}, {}, {
    [path.join(root, 'repo.sln')]: { unitySolutionPath: path.join(root, 'repo.sln'), solutionPath: generatedSolution, linkedSourceRoots: [packageRoot], fingerprint: 'a' },
  });
  await service.getStatus(filePath);

  const status = await service.getStatus(packageFile);

  assert.equal(status.solutionPath, generatedSolution);
  assert.equal(servers.length, 1);
});
