#!/usr/bin/env node
// Stdio MCP server `cloudcli-chat`: tools an agent uses on the chat it runs in, and to start new chats.
// Self-contained on purpose: it may run straight from source through tsx, where
// the `@/` path aliases do not resolve.

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

const apiUrl = (process.env.CLOUDCLI_CHAT_TOOLS_API_URL || 'http://127.0.0.1:3001/api/chat-tools-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_CHAT_TOOLS_MCP_TOKEN || '';
// Set per chat turn by the provider runtime (AGENT_SESSION_ID_ENV in server/shared/utils.ts).
const sessionId = process.env.CLOUDCLI_SESSION_ID || '';

const tools = [
  {
    name: 'set_chat_name',
    description: 'Set the name of the current chat as shown in the CloudCLI sidebar. Use a short name of 2 or 3 words that says what the chat is about.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The new chat name, 2 or 3 words.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'start_chat',
    description: 'Start a new CloudCLI chat that runs the given message as its first turn, in auto permission mode and on the same provider as this chat. '
      + 'By default it is a thread of this chat, folded under it in the CloudCLI sidebar. It is a full chat the user can open and talk to, not a subagent. '
      + 'Returns as soon as the chat has started, without waiting for its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The first message. The new chat has no history, so it must stand alone.' },
        model: { type: 'string', description: 'Model for the new chat, as the model picker names it (e.g. "opus", "sonnet", "fable").' },
        effort: { type: 'string', description: 'Optional reasoning effort: "low", "medium", "high", "xhigh" or "max".' },
        projectPath: { type: 'string', description: 'Optional project folder. Defaults to the project this chat runs in.' },
        parentSessionId: { type: 'string', description: 'Optional session id of the chat to make this a thread of. Defaults to this chat. Threads are one level deep: a thread of a thread goes to its parent.' },
        topLevel: { type: 'boolean', description: 'Start an ordinary top-level chat instead of a thread.' },
      },
      required: ['message', 'model'],
    },
  },
  {
    name: 'resume_chat',
    description: 'Send a message to an existing CloudCLI chat that is no longer running, which resumes it with the message as its next turn, '
      + 'in auto permission mode and on the model it last ran with. Use it when SendMessage cannot reach a chat because its session has ended. '
      + 'The chat does not know who sent the message, so say so in it. Refused while the chat is running. '
      + 'Returns as soon as the turn has started, without waiting for its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id of the chat to resume.' },
        message: { type: 'string', description: 'The message to send.' },
      },
      required: ['sessionId', 'message'],
    },
  },
  {
    name: 'list_worktree_locks',
    description: 'List the worktree locks this chat holds: per locked worktree its unit key, suffix and checkout paths. '
      + 'The unit key and suffix are what release_worktree_locks takes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'release_worktree_locks',
    description: 'Release worktree locks this chat holds, so other chats can work in those checkouts. '
      + 'Pass unit and suffix to release one worktree, or all: true when you are done with every worktree. '
      + 'Only releases locks this chat holds; a lock another chat holds is left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Unit key as list_worktree_locks reports it, e.g. "group:<name>" or "repo:<path>".' },
        suffix: { type: 'string', description: 'Worktree suffix, the <x> of <repo>-<x>. "" is the main checkout.' },
        all: { type: 'boolean', description: 'Release every lock this chat holds.' },
      },
    },
  },
];

type WorktreeClaim = { unit: string; unitName?: string; suffix: string; repos: { path: string }[] };
type ReleasedLock = { unit: string; suffix: string; checkout: string };

function describeWorktree(unit: string, suffix: string, paths: string[]): string {
  return `${unit} ${suffix ? `worktree "${suffix}"` : 'main checkout'}: ${paths.join(', ')}`;
}

function formatClaims(claims: WorktreeClaim[]): string {
  if (!claims.length) return 'This chat holds no worktree locks.';
  const lines = claims.map((claim) => `- ${describeWorktree(claim.unit, claim.suffix, claim.repos.map((repo) => repo.path))}`);
  return `This chat holds ${claims.length} worktree lock(s):\n${lines.join('\n')}`;
}

/** The script reports one released lock per repo; this folds them back into one line per worktree. */
function formatReleased(released: ReleasedLock[]): string {
  if (!released.length) return 'This chat held no matching worktree lock, so nothing was released.';
  const worktrees = new Map<string, { unit: string; suffix: string; paths: string[] }>();
  for (const lock of released) {
    const id = `${lock.unit}\u0000${lock.suffix}`;
    if (!worktrees.has(id)) worktrees.set(id, { unit: lock.unit, suffix: lock.suffix, paths: [] });
    worktrees.get(id)!.paths.push(lock.checkout);
  }
  const lines = [...worktrees.values()].map((worktree) => `- ${describeWorktree(worktree.unit, worktree.suffix, worktree.paths)}`);
  return `Released ${worktrees.size} worktree(s):\n${lines.join('\n')}`;
}

async function callChatToolsApi(toolName: string, input: Record<string, unknown>): Promise<unknown> {
  if (!apiToken) {
    throw new Error('CLOUDCLI_CHAT_TOOLS_MCP_TOKEN is not configured.');
  }
  if (!sessionId) {
    throw new Error('This chat was not started from CloudCLI, so there is no chat to act on (CLOUDCLI_SESSION_ID is not set).');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, sessionId }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: { message?: string } | string };
  if (!response.ok || data.success === false) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || `CloudCLI request failed (${response.status})`);
  }
  return data.data;
}

async function callTool(name: string, args: Record<string, unknown>) {
  try {
    switch (name) {
      case 'set_chat_name': {
        const result = await callChatToolsApi(name, { name: args.name }) as { summary?: string };
        return { content: [{ type: 'text', text: `Chat renamed to "${result?.summary ?? args.name}".` }] };
      }
      case 'start_chat': {
        const input = { message: args.message, model: args.model, effort: args.effort, projectPath: args.projectPath, parentSessionId: args.parentSessionId, topLevel: args.topLevel };
        const result = await callChatToolsApi(name, input) as { sessionId: string; projectPath: string; parentSessionId: string | null };
        const placement = result.parentSessionId ? `as a thread of ${result.parentSessionId}` : 'as a top-level chat';
        return { content: [{ type: 'text', text: `Started chat ${result.sessionId} in ${result.projectPath} ${placement}.` }] };
      }
      case 'resume_chat': {
        const result = await callChatToolsApi(name, { targetSessionId: args.sessionId, message: args.message }) as { sessionId: string };
        return { content: [{ type: 'text', text: `Resumed chat ${result.sessionId} with the message.` }] };
      }
      case 'list_worktree_locks': {
        const result = await callChatToolsApi(name, {}) as { claims: WorktreeClaim[] };
        return { content: [{ type: 'text', text: formatClaims(result.claims) }] };
      }
      case 'release_worktree_locks': {
        const result = await callChatToolsApi(name, { unit: args.unit, suffix: args.suffix, all: args.all }) as { released: ReleasedLock[] };
        return { content: [{ type: 'text', text: formatReleased(result.released) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
  }
}

async function handleMessage(message: JsonRpcRequest) {
  switch (message.method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cloudcli-chat', version: '1.0.0' } };
    case 'tools/list':
      return { tools };
    case 'tools/call': {
      const params = message.params || {};
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      return callTool(String(params.name || ''), args);
    }
    case 'ping':
      return {};
    default:
      if (message.method.startsWith('notifications/')) return undefined;
      throw new Error(`Unsupported method: ${message.method}`);
  }
}

// MCP stdio transport: newline-delimited JSON-RPC, one message per line.
function writeMessage(message: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) continue;

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(error) } });
        return;
      }
      try {
        const result = await handleMessage(request);
        if (request.id !== undefined) writeMessage({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        if (request.id !== undefined) {
          writeMessage({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      }
    })();
  }
});
