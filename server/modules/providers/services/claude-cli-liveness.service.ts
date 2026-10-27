import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * One Claude CLI process that is currently producing a response.
 *
 * `providerSessionId` is Claude's own session id, which is what the registry
 * records; callers map it onto an app session themselves.
 */
type LiveClaudeCliSession = {
  providerSessionId: string;
  startedAt: number;
};

/**
 * Claude Code keeps one file per running session here, named `<pid>.json`.
 * The directory belongs to the CLI, not to CloudCLI: it is only ever read.
 */
const registryDirectory = () => path.join(os.homedir(), '.claude', 'sessions');

/**
 * Upper bound on registry files inspected per poll.
 *
 * The running-sessions endpoint is polled continuously, so a directory left
 * full of stale files by repeated crashes must not turn every poll into
 * unbounded filesystem work. Real installations hold a handful of entries.
 */
const MAX_REGISTRY_FILES = 256;

// Bounds the wait for a killed CLI to disappear from the process table.
const PROCESS_EXIT_TIMEOUT = 5000;
const PROCESS_EXIT_POLL_INTERVAL = 100;

/**
 * Whether `pid` is still the process the registry recorded.
 *
 * A registry file outlives a crash, so its mere presence proves nothing. The
 * signal-0 probe answers "does this pid exist" (EPERM means it exists but is
 * owned by someone else, which still counts), and on Linux the recorded
 * `procStart` is compared against the kernel's start-time for that pid so a
 * reused pid cannot be mistaken for the original process.
 */
async function isRecordedProcessAlive(pid: number, procStart: unknown): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') {
      return false;
    }
  }

  if (process.platform !== 'linux' || typeof procStart !== 'string' || !procStart) {
    return true;
  }

  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field is parenthesised and may itself contain spaces, so the
    // fields are counted from the last ')'. starttime is the 22nd field
    // overall, i.e. the 20th of what follows the comm field.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] === procStart;
  } catch {
    // No procfs entry means the process is gone between the two checks.
    return false;
  }
}

/** One live CLI process as its registry file records it. */
type LiveRegistryEntry = LiveClaudeCliSession & {
  pid: number;
  procStart: unknown;
  isBusy: boolean;
};

/** Reads one registry file, returning null for anything that is not a live process. */
async function readLiveRegistryEntry(filePath: string): Promise<LiveRegistryEntry | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    // Unreadable, half-written or malformed entries are simply not evidence
    // of a running session.
    return null;
  }

  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return null;
  }

  const providerSessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
  const pid = typeof record.pid === 'number' ? record.pid : NaN;
  if (!providerSessionId || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (!(await isRecordedProcessAlive(pid, record.procStart))) {
    return null;
  }

  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  return { providerSessionId, startedAt, pid, procStart: record.procStart, isBusy: record.status === 'busy' };
}

/** Reads every live entry in the CLI's process registry. */
async function listLiveRegistryEntries(): Promise<LiveRegistryEntry[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(registryDirectory());
  } catch {
    // No registry directory at all is the normal case for an install that has
    // never run the CLI, and an unreadable one is not worth failing a poll for.
    return [];
  }

  const registryFiles = entries.filter((entry) => entry.endsWith('.json')).slice(0, MAX_REGISTRY_FILES);
  const sessions = await Promise.all(
    registryFiles.map((entry) => readLiveRegistryEntry(path.join(registryDirectory(), entry))),
  );

  return sessions.filter((session): session is LiveRegistryEntry => session !== null);
}

/**
 * Lists the Claude CLI sessions that are mid-turn right now.
 *
 * Used by the providers module's sessions service so the running-sessions poll
 * also reports turns driven outside CloudCLI's own chat runs — including the
 * `claude` processes CloudCLI itself spawns for the Shell view, which live in
 * the PTY map rather than the chat-run registry. Liveness is ephemeral, so it
 * is recomputed on every read instead of being cached or persisted.
 */
export async function listBusyClaudeCliSessions(): Promise<LiveClaudeCliSession[]> {
  const entries = await listLiveRegistryEntries();
  return entries
    .filter((entry) => entry.isBusy)
    .map(({ providerSessionId, startedAt }) => ({ providerSessionId, startedAt }));
}

/**
 * Kills every Claude CLI process attached to one Claude session, busy or idle,
 * wherever it was started (the app, its Shell view, or a terminal outside it),
 * and resolves once each has exited or the timeout passed.
 *
 * Used by the providers module's sessions service when a session is archived
 * with `stopProcesses`, so no CLI keeps appending to the archived transcript.
 * @returns The number of processes that were signalled.
 */
export async function killClaudeCliProcesses(providerSessionId: string): Promise<number> {
  const targets = (await listLiveRegistryEntries()).filter((entry) => entry.providerSessionId === providerSessionId);
  for (const target of targets) {
    try {
      process.kill(target.pid);
    } catch (error) {
      // ESRCH: it exited between the liveness probe and the kill.
      if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
        throw error;
      }
    }
  }

  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT;
  for (const target of targets) {
    while (Date.now() < deadline && (await isRecordedProcessAlive(target.pid, target.procStart))) {
      await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_INTERVAL));
    }
  }

  return targets.length;
}
