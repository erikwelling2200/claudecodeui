import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord, readStringArray } from '@/shared/utils.js';

/**
 * The permission rules one Claude settings file contributes.
 *
 * `status` says whether the rules could be read at all: `missing` means there
 * is no such file, `invalid` means it exists but the CLI would not load it
 * either (unreadable, over its size cap, or not a JSON object). Both report
 * empty rule lists rather than failing the request, so one bad file never hides
 * the others.
 */
type ClaudeSettingsPermissionSource = {
  scope: 'user' | 'managed';
  path: string;
  status: 'ok' | 'missing' | 'invalid';
  allow: string[];
  deny: string[];
  ask: string[];
  /**
   * Whether the file carries an `allow` or `deny` key at all, so a caller can
   * tell "no rules written here yet" from "the rules here are empty".
   */
  configured: boolean;
};

/**
 * The user's own settings file. The CLI reads it from `CLAUDE_CONFIG_DIR` when
 * that is set, and the server forwards its whole env to every CLI it spawns,
 * so the same override has to apply here.
 */
const userSettingsPath = (): string => {
  const configDirectory = process.env.CLAUDE_CONFIG_DIR?.trim();
  const baseDirectory = configDirectory && path.isAbsolute(configDirectory)
    ? configDirectory
    : path.join(os.homedir(), '.claude');
  return path.join(baseDirectory, 'settings.json');
};

/** The administrator-managed settings file, at the fixed path the CLI uses per OS. */
const managedSettingsPath = (): string => {
  if (process.platform === 'darwin') {
    return '/Library/Application Support/ClaudeCode/managed-settings.json';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  }
  return '/etc/claude-code/managed-settings.json';
};

// The CLI refuses to load a settings file larger than this (2 MB).
const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Decodes a settings file the way the CLI does: UTF-16LE when it starts with
 * that byte order mark, UTF-8 otherwise, without the leading BOM. Windows
 * editors and PowerShell often save one, and the CLI still applies such files.
 */
const isUtf16LittleEndian = (bytes: Buffer): boolean =>
  bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;

const decodeSettingsFile = (bytes: Buffer): string =>
  bytes.toString(isUtf16LittleEndian(bytes) ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');

/**
 * A change to the stored rules, as what to add and what to remove rather than
 * as a whole replacement list. Sent this way so a rule another machine synced
 * in, or the user added by hand, between the panel loading and Save being
 * pressed is left alone instead of being wiped by a stale snapshot.
 */
export type RuleDelta = {
  allow: { add?: string[]; remove?: string[] };
  deny: { add?: string[]; remove?: string[] };
};

/** Keeps non-empty string rules only, without duplicates, in file order. */
const readRuleList = (value: unknown): string[] => [
  ...new Set((readStringArray(value) ?? []).map((rule) => rule.trim()).filter(Boolean)),
];

async function readPermissionSource(
  scope: ClaudeSettingsPermissionSource['scope'],
  filePath: string,
): Promise<ClaudeSettingsPermissionSource> {
  const empty = { scope, path: filePath, allow: [], deny: [], ask: [], configured: false };

  let content: string;
  try {
    if ((await stat(filePath)).size > MAX_SETTINGS_FILE_BYTES) {
      return { ...empty, status: 'invalid' };
    }
    content = decodeSettingsFile(await readFile(filePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...empty, status: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'invalid' };
  }

  // The CLI loads an empty or whitespace-only file as `{}`.
  if (!content.trim()) {
    return { ...empty, status: 'ok' };
  }

  let settings: Record<string, unknown> | null;
  try {
    settings = readObjectRecord(JSON.parse(content));
  } catch {
    settings = null;
  }
  if (!settings) {
    return { ...empty, status: 'invalid' };
  }

  // A file without a `permissions` block is perfectly valid; it just adds no rules.
  const permissions = readObjectRecord(settings.permissions) ?? {};
  return {
    ...empty,
    status: 'ok',
    allow: readRuleList(permissions.allow),
    deny: readRuleList(permissions.deny),
    ask: readRuleList(permissions.ask),
    configured: permissions.allow !== undefined || permissions.deny !== undefined,
  };
}

/**
 * The user's settings file as an object that can be written back, with the
 * encoding it arrived in so a write puts it back the way the CLI — and the
 * user's own editor — expects to find it. A file that is absent or empty
 * starts from `{}`; one that is unreadable or not an object throws, because
 * overwriting it would discard settings this code cannot see.
 */
async function readUserSettingsForWrite(filePath: string): Promise<{ settings: Record<string, unknown>; utf16: boolean }> {
  let bytes: Buffer;
  try {
    if ((await stat(filePath)).size > MAX_SETTINGS_FILE_BYTES) {
      throw new Error(`${filePath} is over the size the CLI loads, so its rules cannot be edited`);
    }
    bytes = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { settings: {}, utf16: false };
    }
    throw error;
  }

  const utf16 = isUtf16LittleEndian(bytes);
  const content = decodeSettingsFile(bytes);
  if (!content.trim()) {
    return { settings: {}, utf16 };
  }

  const settings = readObjectRecord(JSON.parse(content));
  if (!settings) {
    throw new Error(`${filePath} is not a JSON object, so its rules cannot be edited`);
  }
  return { settings, utf16 };
}

/** Applies one list's additions and removals to what the file currently holds. */
const applyRuleDelta = (current: string[], delta: { add?: string[]; remove?: string[] }): string[] => {
  const removed = new Set(delta.remove ?? []);
  return readRuleList([...current.filter((rule) => !removed.has(rule)), ...(delta.add ?? [])]);
};

/**
 * Applies a change to the allow and deny rules in the user's settings file,
 * leaving the rest of it — `ask` rules included — exactly as it was.
 *
 * The file is re-read inside this call and the change applied to what it then
 * holds, so a rule another machine synced in, or the user added by hand, since
 * the panel was opened survives. The write goes through a temporary file in the
 * same directory, so an interrupted write cannot leave the CLI with a
 * half-written settings file.
 */
async function writeUserRules(update: RuleDelta, filePath: string): Promise<void> {
  const { settings, utf16 } = await readUserSettingsForWrite(filePath);
  const current = readObjectRecord(settings.permissions) ?? {};
  const permissions = {
    ...current,
    allow: applyRuleDelta(readRuleList(current.allow), update.allow),
    deny: applyRuleDelta(readRuleList(current.deny), update.deny),
  };

  const json = `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`;
  // Unique per write, so two saves at once cannot share a temporary file.
  const temporaryPath = `${filePath}.cloudcli-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, utf16 ? `﻿${json}` : json, utf16 ? 'utf16le' : 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    // Leave no stray .tmp behind: this directory is often a git repository.
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * The permission rules the Claude CLI applies from its own settings files, on
 * top of the allowed/blocked lists CloudCLI passes it.
 *
 * Used by provider.routes.ts for the Claude permissions panel in Settings.
 * Project-level files are left out on purpose: the panel has no project, and
 * those files only apply to chats started inside their project. Only the user
 * file is ever written — the managed file belongs to an administrator.
 */
export const claudeSettingsPermissionsService = {
  /** `managedPath` is only overridden by tests, which cannot write to the system path. */
  async listRuleSources(managedPath: string = managedSettingsPath()): Promise<ClaudeSettingsPermissionSource[]> {
    return Promise.all([
      readPermissionSource('user', userSettingsPath()),
      readPermissionSource('managed', managedPath),
    ]);
  },

  /** Applies a change to the user file's rules, and reports the file as it then reads. */
  async updateUserRules(
    update: RuleDelta,
    filePath: string = userSettingsPath(),
  ): Promise<ClaudeSettingsPermissionSource> {
    await writeUserRules(update, filePath);
    return readPermissionSource('user', filePath);
  },
};
