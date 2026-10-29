import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService, sessionsService } from '@/modules/providers/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import type { ChatToolsAppendMode, ChatToolsSettings } from '@/shared/types.js';
import { AGENT_SESSION_ID_ENV, AppError, appendPromptText, getModuleDirectory } from '@/shared/utils.js';

const require = createRequire(import.meta.url);
const moduleDirectory = getModuleDirectory(import.meta.url);

const SETTINGS_KEY = 'chat_tools_settings';
const MCP_TOKEN_KEY = 'chat_tools_mcp_token';
// The MCP config last written to the providers, so startup only rewrites their config files when it changed.
const MCP_REGISTRATION_KEY = 'chat_tools_mcp_registration';
const MCP_SERVER_NAME = 'cloudcli-chat';
const MAX_CHAT_NAME_LENGTH = 80;

const DEFAULT_APPEND_TEXT = 'Before you start on this message, name this chat: call the `set_chat_name` tool (MCP server `cloudcli-chat`) '
  + 'with a name of 2 or 3 words that says what this chat is about. Then carry on with the message as normal.';

const DEFAULT_SETTINGS: ChatToolsSettings = {
  appendMode: 'first',
  appendText: DEFAULT_APPEND_TEXT,
  renameToolEnabled: true,
};

const APPEND_MODES: ChatToolsAppendMode[] = ['off', 'first', 'every'];

function readSettings(): ChatToolsSettings {
  const raw = appConfigDb.get(SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ChatToolsSettings>) };
  } catch (error) {
    console.warn('[ChatTools] Stored settings are not valid JSON, using defaults:', error instanceof Error ? error.message : error);
    return DEFAULT_SETTINGS;
  }
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(MCP_TOKEN_KEY);
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(MCP_TOKEN_KEY, token);
  return token;
}

/**
 * The compiled build ships `chat-tools-mcp.js` beside this file; a server
 * running from source through tsx only has the `.ts`, which node runs with the
 * tsx loader.
 */
function getMcpCommand(): { command: string; args: string[] } {
  const compiledScript = path.join(moduleDirectory, 'chat-tools-mcp.js');
  if (fs.existsSync(compiledScript)) {
    return { command: process.execPath, args: [compiledScript] };
  }
  const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
  return { command: process.execPath, args: ['--import', tsxLoader, path.join(moduleDirectory, 'chat-tools-mcp.ts')] };
}

function buildMcpServerInput() {
  const { command, args } = getMcpCommand();
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return {
    name: MCP_SERVER_NAME,
    scope: 'user' as const,
    transport: 'stdio' as const,
    command,
    args,
    env: {
      CLOUDCLI_CHAT_TOOLS_MCP_TOKEN: getOrCreateMcpToken(),
      CLOUDCLI_CHAT_TOOLS_API_URL: `http://127.0.0.1:${port}/api/chat-tools-mcp`,
    },
    // Codex starts MCP servers with a minimal environment; this passes the chat's id through.
    envVars: [AGENT_SESSION_ID_ENV],
  };
}

async function registerMcp(): Promise<void> {
  const input = buildMcpServerInput();
  const results = await providerMcpService.addMcpServerToAllProviders(input);
  for (const failed of results.filter((result) => !result.created)) {
    console.warn(`[ChatTools] Could not register the ${MCP_SERVER_NAME} MCP server with ${failed.provider}: ${failed.error}`);
  }
  appConfigDb.set(MCP_REGISTRATION_KEY, JSON.stringify(input));
}

async function unregisterMcp(): Promise<void> {
  await providerMcpService.removeMcpServerFromAllProviders({ name: MCP_SERVER_NAME, scope: 'user' });
  appConfigDb.set(MCP_REGISTRATION_KEY, '');
}

function parseAppendMode(value: unknown): ChatToolsAppendMode {
  if (!APPEND_MODES.includes(value as ChatToolsAppendMode)) {
    throw new AppError(`appendMode must be one of ${APPEND_MODES.join(', ')}`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
  return value as ChatToolsAppendMode;
}

// chatToolsService: used by the chat-tools routes, by the websocket module's
// chat dispatch to append text to prompts, and by the server entrypoint to
// register the MCP server at startup.
export const chatToolsService = {
  getSettings(): ChatToolsSettings & { defaultAppendText: string } {
    return { ...readSettings(), defaultAppendText: DEFAULT_APPEND_TEXT };
  },

  async updateSettings(changes: Partial<ChatToolsSettings>): Promise<ChatToolsSettings & { defaultAppendText: string }> {
    const current = readSettings();
    const next: ChatToolsSettings = {
      appendMode: changes.appendMode === undefined ? current.appendMode : parseAppendMode(changes.appendMode),
      appendText: typeof changes.appendText === 'string' ? changes.appendText : current.appendText,
      renameToolEnabled: typeof changes.renameToolEnabled === 'boolean' ? changes.renameToolEnabled : current.renameToolEnabled,
    };
    appConfigDb.set(SETTINGS_KEY, JSON.stringify(next));

    if (next.renameToolEnabled && !current.renameToolEnabled) await registerMcp();
    if (!next.renameToolEnabled && current.renameToolEnabled) await unregisterMcp();
    return this.getSettings();
  },

  /**
   * Registers the MCP server with every provider when the rename tool is on and
   * the registered config is missing or out of date (another port, or a move
   * between source and compiled builds).
   */
  async ensureMcpRegistered(): Promise<void> {
    if (!readSettings().renameToolEnabled) return;
    if (appConfigDb.get(MCP_REGISTRATION_KEY) === JSON.stringify(buildMcpServerInput())) return;
    await registerMcp();
  },

  /**
   * Returns the prompt with the configured text appended, when the append mode
   * covers this message. `isFirstMessage` is true for the turn that starts a
   * chat's conversation. Slash commands are left alone, because the CLI would
   * read the appended text as the command's arguments.
   */
  appendToPrompt(prompt: string, isFirstMessage: boolean): string {
    const { appendMode, appendText } = readSettings();
    if (appendMode === 'off' || (appendMode === 'first' && !isFirstMessage)) return prompt;
    if (prompt.trimStart().startsWith('/')) return prompt;
    return appendPromptText(prompt, appendText);
  },

  getMcpToken(): string {
    return getOrCreateMcpToken();
  },

  /** Renames a chat on an agent's request and pushes the new name to every open sidebar. */
  async setChatName(sessionId: string, name: string): Promise<{ sessionId: string; summary: string }> {
    const summary = name.replace(/\s+/g, ' ').trim();
    if (!summary) {
      throw new AppError('name is required', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }
    if (summary.length > MAX_CHAT_NAME_LENGTH) {
      throw new AppError(`name is longer than ${MAX_CHAT_NAME_LENGTH} characters`, { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
    }

    const result = sessionsService.renameSessionById(sessionId, summary);
    await broadcastSessionUpserted(sessionId);
    return result;
  },
};
