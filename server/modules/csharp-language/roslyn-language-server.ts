import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ICsharpLanguageServer } from '@/shared/interfaces.js';
import type { CsharpDocumentRequest, CsharpLanguageStatus } from '@/shared/types.js';

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

// Finding every reference of a widely used Unity type can take most of a minute on a cold solution.
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Runs `Microsoft.CodeAnalysis.LanguageServer` over stdio for one solution. Created by the csharp-language
 * module's composition root, one per `.sln`, and driven by its service through `ICsharpLanguageServer`.
 */
export class RoslynLanguageServer implements ICsharpLanguageServer {
  readonly solutionPath: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openDocuments = new Map<string, { version: number; text: string }>();
  private status: CsharpLanguageStatus;
  private semanticTokenTypes: string[] = [];
  private receiveBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private lastErrorLog: string | null = null;
  private semanticRevision = 0;

  constructor(executablePath: string, solutionPath: string) {
    this.solutionPath = solutionPath;
    this.status = { state: 'starting', solutionPath, message: null, semanticRevision: 0 };

    const logDirectory = path.join(os.tmpdir(), 'cloudcli-roslyn-logs');
    mkdirSync(logDirectory, { recursive: true });
    this.child = spawn(executablePath, [
      '--stdio',
      '--logLevel', 'Warning',
      '--telemetryLevel', 'off',
      '--extensionLogDirectory', logDirectory,
      // Roslyn exits on its own when this server process dies, so a crash never leaves it running.
      '--clientProcessId', String(process.pid),
    ], { windowsHide: true });

    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Roslyn writes its own diagnostics to stderr; the protocol log messages carry what matters.
    this.child.stderr.on('data', () => undefined);
    this.child.on('error', (error) => this.fail(`Could not start the Roslyn language server: ${error.message}`));
    this.child.on('exit', (code) => this.fail(`The Roslyn language server exited with code ${code ?? 'unknown'}${this.lastErrorLog ? `: ${this.lastErrorLog}` : ''}`));

    void this.initialize();
  }

  getStatus(): CsharpLanguageStatus {
    return { ...this.status, semanticRevision: this.semanticRevision };
  }

  getSemanticTokenTypes(): string[] {
    return this.semanticTokenTypes;
  }

  syncDocument({ filePath, text }: CsharpDocumentRequest): void {
    const uri = pathToFileURL(filePath).href;
    const openDocument = this.openDocuments.get(uri);
    if (!openDocument) {
      this.openDocuments.set(uri, { version: 1, text });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csharp', version: 1, text } });
      return;
    }
    if (openDocument.text === text) return;

    openDocument.version += 1;
    openDocument.text = text;
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: openDocument.version },
      contentChanges: [{ text }],
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.status.state === 'failed') {
      return Promise.reject(new Error(this.status.message ?? 'The Roslyn language server is not running'));
    }

    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ id, method, params });
    });
  }

  dispose(): void {
    this.fail('The Roslyn language server was stopped');
    this.child.kill();
  }

  private async initialize(): Promise<void> {
    try {
      const result = await this.request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(path.dirname(this.solutionPath)).href,
        capabilities: {
          // Roslyn answers semantic tokens from partial analysis first and asks for a refresh once it is complete.
          workspace: { configuration: true, semanticTokens: { refreshSupport: true } },
          textDocument: {
            semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
            definition: { linkSupport: false },
            references: {},
          },
          window: { workDoneProgress: false },
        },
      }) as { capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } } };

      this.semanticTokenTypes = result.capabilities?.semanticTokensProvider?.legend?.tokenTypes ?? [];
      this.notify('initialized', {});
      this.notify('solution/open', { solution: pathToFileURL(this.solutionPath).href });
      this.status = { state: 'loading', solutionPath: this.solutionPath, message: null, semanticRevision: 0 };
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(message: string): void {
    if (this.status.state === 'failed') return;
    this.status = { state: 'failed', solutionPath: this.solutionPath, message, semanticRevision: 0 };
    for (const pendingRequest of this.pending.values()) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(new Error(message));
    }
    this.pending.clear();
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  // Splits the stdout byte stream into `Content-Length`-framed JSON-RPC messages.
  private receive(chunk: Buffer): void {
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
    for (;;) {
      const headerEnd = this.receiveBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const lengthMatch = /Content-Length: *(\d+)/i.exec(this.receiveBuffer.subarray(0, headerEnd).toString('ascii'));
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(lengthMatch?.[1]);
      if (lengthMatch && this.receiveBuffer.length < bodyEnd) return;

      // A broken stream must fail this one server, never throw out of the event handler and take the app down.
      try {
        if (!lengthMatch) throw new Error('a message arrived without a Content-Length header');
        const message = JSON.parse(this.receiveBuffer.subarray(bodyStart, bodyEnd).toString('utf8')) as JsonRpcMessage;
        this.receiveBuffer = this.receiveBuffer.subarray(bodyEnd);
        this.handleMessage(message);
      } catch (error) {
        this.fail(`The Roslyn language server sent an unreadable message: ${error instanceof Error ? error.message : String(error)}`);
        this.child.kill();
        return;
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.method) {
      this.send({ id: message.id, result: this.answerServerRequest(message.method, message.params) });
      return;
    }

    if (message.id !== undefined) {
      const pendingRequest = this.pending.get(Number(message.id));
      if (!pendingRequest) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pendingRequest.timeout);
      if (message.error) pendingRequest.reject(new Error(message.error.message ?? 'Roslyn returned an error'));
      else pendingRequest.resolve(message.result);
      return;
    }

    if (message.method === 'workspace/projectInitializationComplete') {
      this.status = { state: 'ready', solutionPath: this.solutionPath, message: null, semanticRevision: 0 };
    } else if (message.method === 'window/logMessage') {
      const log = message.params as { type?: number; message?: string };
      if (log.type === 1 && log.message) this.lastErrorLog = log.message;
    }
  }

  private answerServerRequest(method: string, params: unknown): unknown {
    if (method === 'workspace/semanticTokens/refresh') {
      this.semanticRevision += 1;
      return null;
    }
    if (method !== 'workspace/configuration') return null;

    // Unity's generated projects have no packages, so the per-project `dotnet restore` only costs load time.
    const items = (params as { items?: { section?: string }[] }).items ?? [];
    return items.map((item) => (item.section?.endsWith('dotnet_enable_automatic_restore') ? false : null));
  }
}
