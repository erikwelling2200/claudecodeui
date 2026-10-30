import { api, readApiJson } from '@/shared/api';
import type { ClaudeSettingsPermissionSource } from '@/shared/types';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';

/**
 * Claude's allow and deny rules live in the CLI's own `~/.claude/settings.json`,
 * so one set of rules governs this UI and the user's terminal sessions alike —
 * and, for a settings directory kept in version control, every machine it is
 * synced to. The CLI applies that file itself, which is why these rules bind
 * whether or not the UI passes them to a run.
 *
 * The `claudePermissions` preference stays behind this module as a cache of the
 * file. The composer reads the rules while it is building a turn to send, which
 * is synchronous and cannot wait on a fetch; the cache is refreshed whenever
 * the file is read or written.
 *
 * Only Claude works this way. The other providers have no equivalent file, so
 * their preferences remain the rules themselves.
 */

type ClaudeRules = { allow: string[]; deny: string[] };

type SourcesResponse = { data?: { sources?: ClaudeSettingsPermissionSource[] } };

type CachedPermissions = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  /** Set once the settings file has become the record these rules come from. */
  migratedToSettingsFile?: boolean;
};

const readCache = (): CachedPermissions => readUserPreference<CachedPermissions>('claudePermissions', {});

/** Keeps the cache's own `skipPermissions`, which is a session mode rather than a rule. */
const writeCache = (rules: ClaudeRules): void => {
  const cached = readCache();
  writeUserPreference('claudePermissions', {
    ...cached,
    allowedTools: rules.allow,
    disallowedTools: rules.deny,
    migratedToSettingsFile: true,
  });
};

const mergeRules = (first: string[], second: string[]): string[] => [...new Set([...first, ...second])];

/**
 * Reads the rules from the settings file and refreshes the cache from them.
 *
 * The very first read also writes up any rule the cache holds and the file does
 * not, which carries across a list built before this UI used the file. That
 * happens once and never again: from then on the file is the record, so a rule
 * deleted there — in the panel, by hand, or by a sync from another machine —
 * stays deleted instead of coming back from a stale cache.
 */
export async function loadClaudeRules(): Promise<ClaudeRules | null> {
  let source: ClaudeSettingsPermissionSource | undefined;
  try {
    const response = await api.providers.claudeSettingsPermissions();
    const payload = await readApiJson<SourcesResponse>(response);
    source = payload.data?.sources?.find((entry) => entry.scope === 'user');
  } catch (error) {
    console.error('Error loading Claude permission rules from the settings file:', error);
    return null;
  }

  // An unreadable file is not an empty one: leave the cache as the last thing
  // known to be true rather than reporting the user has no rules.
  if (!source || source.status === 'invalid') {
    return null;
  }

  const cached = readCache();
  const fileRules: ClaudeRules = { allow: source.allow, deny: source.deny };
  if (cached.migratedToSettingsFile) {
    writeCache(fileRules);
    return fileRules;
  }

  const merged: ClaudeRules = {
    allow: mergeRules(fileRules.allow, cached.allowedTools ?? []),
    deny: mergeRules(fileRules.deny, cached.disallowedTools ?? []),
  };

  const carriesOver = merged.allow.length !== fileRules.allow.length
    || merged.deny.length !== fileRules.deny.length;
  if (carriesOver) {
    return (await saveClaudeRules(merged)) ? merged : fileRules;
  }

  writeCache(fileRules);
  return fileRules;
}

/** Saves the rules to the settings file, and caches them once the file has them. */
export async function saveClaudeRules(rules: ClaudeRules): Promise<boolean> {
  try {
    const response = await api.providers.saveClaudeSettingsPermissions(rules);
    const payload = await readApiJson<{ data?: { source?: ClaudeSettingsPermissionSource } }>(response);
    const saved = payload.data?.source;
    writeCache(saved ? { allow: saved.allow, deny: saved.deny } : rules);
    return true;
  } catch (error) {
    console.error('Error saving Claude permission rules to the settings file:', error);
    return false;
  }
}

/** The rules as last read, for the paths that cannot wait on the file. */
export function readCachedClaudeRules(): ClaudeRules {
  const cached = readCache();
  return { allow: cached.allowedTools ?? [], deny: cached.disallowedTools ?? [] };
}
