import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ICsharpLanguageServer } from '@/shared/interfaces.js';
import type {
  CsharpDocumentRequest,
  CsharpLanguageServices,
  CsharpLanguageStatus,
  CsharpLocation,
  CsharpPositionRequest,
  CsharpReferenceAccess,
  CsharpSemanticResult,
  CsharpSemanticToken,
} from '@/shared/types.js';

import { isUnderAnyRoot, pickSolutionFile } from './source-solution.js';
import type { PreparedSolution } from './source-solution.js';

type CsharpLanguageServiceDependencies = {
  /** Absolute path of `Microsoft.CodeAnalysis.LanguageServer`, or null when no install was found. */
  locateServerExecutable(): Promise<string | null>;
  listDirectory(directoryPath: string): Promise<string[]>;
  readTextFile(filePath: string): Promise<string>;
  /** The solution to load in place of a Unity `.sln`, such as one that compiles consumed packages from source. */
  prepareSolution(unitySolutionPath: string): Promise<PreparedSolution>;
  createServer(executablePath: string, solutionPath: string): ICsharpLanguageServer;
  now(): number;
  /** A server nobody asked anything for this long is stopped; the next request starts it again. */
  idleTimeoutMs: number;
};

type ProtocolRange = { start: { line: number; character: number } };
type ProtocolLocation = { uri?: string; range?: ProtocolRange; targetUri?: string; targetSelectionRange?: ProtocolRange };
type ProtocolDocumentHighlight = { range?: ProtocolRange; kind?: number };

// A failed server is kept, and reported, this long before a request may start a fresh one.
const FAILED_SERVER_RETRY_MS = 60_000;
const PREVIEW_MAX_LENGTH = 200;
// DocumentHighlightKind from the protocol; 1 (Text) is neither and stays unclassified.
const HIGHLIGHT_KIND_ACCESS: Record<number, CsharpReferenceAccess> = { 2: 'read', 3: 'write' };

function locationKey(filePath: string, line: number, character: number): string {
  return `${path.resolve(filePath).toLowerCase()}|${line}|${character}`;
}

/** Picks the solution Roslyn should load for a file: that of the nearest folder above it holding one. */
async function findSolutionPath(filePath: string, listDirectory: (directoryPath: string) => Promise<string[]>): Promise<string | null> {
  let directory = path.dirname(path.resolve(filePath));
  for (;;) {
    const solutionPath = pickSolutionFile(directory, await listDirectory(directory));
    if (solutionPath) return solutionPath;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

// Semantic tokens arrive as quintuples of line delta, start delta, length, type index and modifiers.
function decodeSemanticTokens(data: number[], tokenTypes: string[]): CsharpSemanticToken[] {
  const tokens: CsharpSemanticToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const lineDelta = data[index];
    line += lineDelta;
    character = lineDelta === 0 ? character + data[index + 1] : data[index + 1];
    tokens.push({ line, character, length: data[index + 2], type: tokenTypes[data[index + 3]] ?? 'unknown' });
  }
  return tokens;
}

/**
 * Builds the C# language service for the csharp-language composition root and its tests. All lookups run
 * against the editor's own text for the requested file, so results match an unsaved buffer.
 */
export function createCsharpLanguageService(dependencies: CsharpLanguageServiceDependencies): CsharpLanguageServices {
  const servers = new Map<string, ICsharpLanguageServer>();
  const preparedSolutions = new Map<string, PreparedSolution>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const failedSince = new Map<string, number>();

  function keepAlive(server: ICsharpLanguageServer): void {
    clearTimeout(idleTimers.get(server.solutionPath));
    const timer = setTimeout(() => {
      servers.delete(server.solutionPath);
      preparedSolutions.delete(server.solutionPath);
      idleTimers.delete(server.solutionPath);
      server.dispose();
    }, dependencies.idleTimeoutMs);
    // An idle timer alone must not keep the CloudCLI process alive.
    timer.unref();
    idleTimers.set(server.solutionPath, timer);
  }

  // Resolves the server for a file, starting it on first use. Returns a status instead when there is none to use.
  async function resolveServer(filePath: string): Promise<{ server: ICsharpLanguageServer | null; status: CsharpLanguageStatus }> {
    const unitySolutionPath = await findSolutionPath(filePath, dependencies.listDirectory);
    if (!unitySolutionPath) {
      return { server: null, status: { state: 'unavailable', solutionPath: null, message: 'No .sln file found in any folder above this file', semanticRevision: 0 } };
    }

    const prepared = await dependencies.prepareSolution(unitySolutionPath);
    const { solutionPath } = prepared;
    let server = servers.get(solutionPath);
    // A server whose solution gained or lost projects would keep answering for the old set, so it starts over.
    if (server && preparedSolutions.get(solutionPath)?.fingerprint !== prepared.fingerprint) {
      server.dispose();
      servers.delete(solutionPath);
      failedSince.delete(solutionPath);
      server = undefined;
    }
    preparedSolutions.set(solutionPath, prepared);
    if (server?.getStatus().state === 'failed') {
      const failedAt = failedSince.get(solutionPath) ?? dependencies.now();
      failedSince.set(solutionPath, failedAt);
      if (dependencies.now() - failedAt < FAILED_SERVER_RETRY_MS) return { server: null, status: server.getStatus() };
      server.dispose();
      servers.delete(solutionPath);
      failedSince.delete(solutionPath);
      server = undefined;
    }

    // A package file that a consuming project's loaded solution already compiles is answered there, instead of
    // loading the package checkout's own solution as well.
    server ??= [...servers.values()].find((candidate) => candidate.getStatus().state !== 'failed'
      && isUnderAnyRoot(filePath, preparedSolutions.get(candidate.solutionPath)?.linkedSourceRoots ?? []));

    if (!server) {
      const executablePath = await dependencies.locateServerExecutable();
      if (!executablePath) {
        return {
          server: null,
          status: {
            state: 'unavailable',
            solutionPath,
            message: 'Roslyn language server not found. Install the C# extension for VS Code or set ROSLYN_LANGUAGE_SERVER_PATH.',
            semanticRevision: 0,
          },
        };
      }
      server = dependencies.createServer(executablePath, solutionPath);
      servers.set(solutionPath, server);
    }

    keepAlive(server);
    return { server, status: server.getStatus() };
  }

  // Runs a lookup once the solution is loaded; before that, only reports the status.
  async function whenReady<TValue>(
    document: CsharpDocumentRequest,
    lookup: (server: ICsharpLanguageServer, uri: string) => Promise<TValue>,
  ): Promise<CsharpSemanticResult<TValue>> {
    const { server, status } = await resolveServer(document.filePath);
    if (!server || status.state !== 'ready') return { status, result: null };

    server.syncDocument(document);
    return { status, result: await lookup(server, pathToFileURL(document.filePath).href) };
  }

  // Other loaded solutions that compile this file: its own project's, and every consuming project's that links its source.
  function otherServersCompiling(filePath: string, primary: ICsharpLanguageServer): ICsharpLanguageServer[] {
    return [...servers.values()].filter((server) => {
      const prepared = preparedSolutions.get(server.solutionPath);
      const roots = [path.dirname(prepared?.unitySolutionPath ?? server.solutionPath), ...(prepared?.linkedSourceRoots ?? [])];
      return server !== primary && server.getStatus().state === 'ready' && isUnderAnyRoot(filePath, roots);
    });
  }

  async function toLocations(
    rawResult: unknown,
    document: CsharpDocumentRequest,
    accesses: Map<string, CsharpReferenceAccess> = new Map(),
  ): Promise<CsharpLocation[]> {
    const rawLocations = (Array.isArray(rawResult) ? rawResult : rawResult ? [rawResult] : []) as ProtocolLocation[];
    const fileLines = new Map<string, Promise<string[]>>();
    const readLines = (filePath: string): Promise<string[]> => {
      if (!fileLines.has(filePath)) {
        const text = path.resolve(filePath) === path.resolve(document.filePath) ? Promise.resolve(document.text) : dependencies.readTextFile(filePath);
        fileLines.set(filePath, text.then((content) => content.split(/\r?\n/)));
      }
      return fileLines.get(filePath)!;
    };

    const locations = await Promise.all(rawLocations.map(async (rawLocation) => {
      const uri = rawLocation.targetUri ?? rawLocation.uri;
      const start = (rawLocation.targetSelectionRange ?? rawLocation.range)?.start;
      // Source-generated documents have no file on disk to open, so only `file:` locations are listed.
      if (!uri?.startsWith('file:') || !start) return null;
      const filePath = fileURLToPath(uri);
      const lines = await readLines(filePath);
      const preview = (lines[start.line] ?? '').trim().slice(0, PREVIEW_MAX_LENGTH);
      return { filePath, line: start.line, character: start.character, preview, access: accesses.get(locationKey(filePath, start.line, start.character)) ?? null };
    }));

    const unique = new Map<string, CsharpLocation>();
    for (const location of locations) {
      if (location) unique.set(locationKey(location.filePath, location.line, location.character), location);
    }
    return [...unique.values()]
      .sort((left, right) => left.filePath.localeCompare(right.filePath) || left.line - right.line || left.character - right.character);
  }

  // References carry no read/write kind, so each file's document highlights for the symbol supply it: one
  // request per file, at the first reference found there.
  async function classifyAccesses(server: ICsharpLanguageServer, rawLocations: ProtocolLocation[]): Promise<Map<string, CsharpReferenceAccess>> {
    const firstPerFile = new Map<string, ProtocolRange['start']>();
    for (const rawLocation of rawLocations) {
      const start = rawLocation.range?.start;
      if (rawLocation.uri?.startsWith('file:') && start && !firstPerFile.has(rawLocation.uri)) firstPerFile.set(rawLocation.uri, start);
    }

    const accesses = new Map<string, CsharpReferenceAccess>();
    await Promise.all([...firstPerFile].map(async ([uri, position]) => {
      let highlights: unknown;
      try {
        highlights = await server.request('textDocument/documentHighlight', { textDocument: { uri }, position });
      } catch {
        // The kind is a detail; a file Roslyn cannot highlight still lists its references, just unclassified.
        return;
      }
      const filePath = fileURLToPath(uri);
      for (const highlight of (Array.isArray(highlights) ? highlights : []) as ProtocolDocumentHighlight[]) {
        const start = highlight.range?.start;
        const access = HIGHLIGHT_KIND_ACCESS[highlight.kind ?? 0];
        if (start && access) accesses.set(locationKey(filePath, start.line, start.character), access);
      }
    }));
    return accesses;
  }

  return {
    async getStatus(filePath) {
      return (await resolveServer(filePath)).status;
    },

    getSemanticTokens(document) {
      return whenReady(document, async (server, uri) => {
        const result = await server.request('textDocument/semanticTokens/full', { textDocument: { uri } }) as { data?: number[] } | null;
        return decodeSemanticTokens(result?.data ?? [], server.getSemanticTokenTypes());
      });
    },

    findDefinition(request: CsharpPositionRequest) {
      return whenReady(request, async (server, uri) => toLocations(await server.request('textDocument/definition', {
        textDocument: { uri },
        position: { line: request.line, character: request.character },
      }), request));
    },

    findReferences(request: CsharpPositionRequest) {
      return whenReady(request, async (server, uri) => {
        const params = {
          textDocument: { uri },
          position: { line: request.line, character: request.character },
          context: { includeDeclaration: true },
        };
        const askers = [server, ...otherServersCompiling(request.filePath, server)];
        const results = await Promise.all(askers.map(async (asker) => {
          keepAlive(asker);
          asker.syncDocument(request);
          const result = await asker.request('textDocument/references', params);
          const rawLocations = (Array.isArray(result) ? result : []) as ProtocolLocation[];
          return { rawLocations, accesses: await classifyAccesses(asker, rawLocations) };
        }));
        const accesses = new Map(results.flatMap((result) => [...result.accesses]));
        return toLocations(results.flatMap((result) => result.rawLocations), request, accesses);
      });
    },
  };
}
