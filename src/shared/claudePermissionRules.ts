import { api, readApiJson } from '@/shared/api';
import type { ClaudeSettingsPermissionSource } from '@/shared/types';
import { readUserPreference, userPreferencesLoadedFromServer, writeUserPreference } from '@/shared/userSettings';

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
};

const readCache = (): CachedPermissions => readUserPreference<CachedPermissions>('claudePermissions', {});

/** Keeps the cache's own `skipPermissions`, which is a session mode rather than a rule. */
const writeCache = (rules: ClaudeRules): void => {
  const cached = readCache();
  writeUserPreference('claudePermissions', {
    ...cached,
    allowedTools: rules.allow,
    disallowedTools: rules.deny,
  });
};

/**
 * Reads the rules from the settings file and refreshes the cache from them.
 *
 * Before the rules moved to the file, each machine kept its own list in its
 * own server's database, built up by "Allow & remember" in the UI alone. The
 * file is obeyed far more widely — by the terminal, and by every machine it
 * is synced to — so that list is never promoted into it on the user's behalf.
 * On each machine's first read, the entries the file lacks are set aside in
 * `claudeRulesNotCarried` for the user to review, and the file is taken as it
 * stands. Nothing is lost and nothing is granted.
 *
 * Nothing is written at all unless the preferences really came from the
 * server: after a failed fetch the cache is empty or stale, and writing from it
 * would overwrite the list this is meant to keep.
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

  const fileRules: ClaudeRules = { allow: source.allow, deny: source.deny };
  if (!userPreferencesLoadedFromServer()) {
    return fileRules;
  }

  if (!readUserPreference<boolean>('claudeRulesMigrated', false)) {
    const cached = readCache();
    const notCarried: ClaudeRules = {
      allow: (cached.allowedTools ?? []).filter((rule) => !fileRules.allow.includes(rule)),
      deny: (cached.disallowedTools ?? []).filter((rule) => !fileRules.deny.includes(rule)),
    };
    if (notCarried.allow.length > 0 || notCarried.deny.length > 0) {
      writeUserPreference('claudeRulesNotCarried', notCarried);
    }
    writeUserPreference('claudeRulesMigrated', true);
  }

  writeCache(fileRules);
  return fileRules;
}

/** The rules this machine held before the move that the file does not carry, for review. */
export function readRulesNotCarried(): ClaudeRules {
  const stored = readUserPreference<Partial<ClaudeRules>>('claudeRulesNotCarried', {});
  return { allow: stored.allow ?? [], deny: stored.deny ?? [] };
}

const ruleDelta = (before: string[], after: string[]) => ({
  add: after.filter((rule) => !before.includes(rule)),
  remove: before.filter((rule) => !after.includes(rule)),
});

/**
 * Saves the rules to the settings file, and caches what the file then holds.
 *
 * What travels is the difference against the rules this client last read, not
 * the list itself, so a rule added on another machine between that read and
 * this save is not wiped by a stale snapshot. The file's own answer is what
 * gets cached, so the cache never claims a rule the file rejected.
 */
export async function saveClaudeRules(rules: ClaudeRules): Promise<boolean> {
  const before = readCachedClaudeRules();
  try {
    const response = await api.providers.saveClaudeSettingsPermissions({
      allow: ruleDelta(before.allow, rules.allow),
      deny: ruleDelta(before.deny, rules.deny),
    });
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
