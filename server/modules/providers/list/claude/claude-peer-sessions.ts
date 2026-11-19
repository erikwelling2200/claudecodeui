import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every running Claude Code process registers itself in `~/.claude/sessions/<pid>.json`,
 * naming its session id and the pipe other sessions message it through. A
 * `<cross-session-message>` names only that pipe, so this is the one place
 * that ties such a message to the chat it came from.
 *
 * A registration file disappears when its process exits, so every pipe seen
 * is kept in `~/.cloudcli/peer-sessions.json`: a message from a chat that has
 * since ended still resolves, as long as that chat ran while the server did.
 */
const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STORE_PATH = path.join(os.homedir(), '.cloudcli', 'peer-sessions.json');
const RESCAN_INTERVAL_MS = 2000;
let sessionIdsByPipe: Map<string, string> | null = null;
let lastScanAt = 0;

function loadStore(): Map<string, string> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(STORE_PATH, 'utf8'))));
  } catch {
    return new Map();
  }
}

function scanRegistry(known: Map<string, string>): void {
  lastScanAt = Date.now();
  let names: string[];
  try {
    names = readdirSync(REGISTRY_DIR);
  } catch {
    return;
  }
  let added = false;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(path.join(REGISTRY_DIR, name), 'utf8'));
      if (typeof entry.messagingSocketPath === 'string' && typeof entry.sessionId === 'string'
        && known.get(entry.messagingSocketPath) !== entry.sessionId) {
        known.set(entry.messagingSocketPath, entry.sessionId);
        added = true;
      }
    } catch {
      // A file the CLI is halfway through writing; the next scan reads it.
    }
  }
  if (added) {
    try {
      mkdirSync(path.dirname(STORE_PATH), { recursive: true });
      writeFileSync(STORE_PATH, JSON.stringify(Object.fromEntries(known)));
    } catch (error) {
      console.warn('[claude-peer-sessions] Could not save the peer session map:', error);
    }
  }
}

/** The Claude session id behind a `uds:` peer address, or undefined when no session registered it. */
export function resolvePeerSessionId(address: string): string | undefined {
  const pipe = address.replace(/^uds:/, '');
  sessionIdsByPipe ??= loadStore();
  if (!sessionIdsByPipe.has(pipe) && Date.now() - lastScanAt > RESCAN_INTERVAL_MS) {
    scanRegistry(sessionIdsByPipe);
  }
  return sessionIdsByPipe.get(pipe);
}
