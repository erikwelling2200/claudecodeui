import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSettingsPermissionSource } from '@/shared/types';

// Claude's rules live in its own settings file so that this UI and the user's
// terminal sessions obey one list, on every machine their settings directory
// is synced to. The preference is only a cache of that file, which these tests
// pin: the file wins on load, a write reaches the file before the cache, a file
// that cannot be read never reads as "no rules" — and a machine's old UI-only
// list is set aside for review, never promoted into the file on its own.

const claudeSettingsPermissions = vi.fn<() => Promise<Response>>();
type Delta = { allow: { add: string[]; remove: string[] }; deny: { add: string[]; remove: string[] } };
const saveClaudeSettingsPermissions = vi.fn<(delta: Delta) => Promise<Response>>();

// Only the endpoints are stubbed; `readApiJson` stays real so the module parses
// the same envelope the server sends.
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    providers: {
      claudeSettingsPermissions: () => claudeSettingsPermissions(),
      saveClaudeSettingsPermissions: (delta: Delta) => saveClaudeSettingsPermissions(delta),
    },
  },
}));

let preferences: Record<string, unknown> = {};
let loadedFromServer = true;

vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (key: string, fallback: unknown) => preferences[key] ?? fallback,
  writeUserPreference: (key: string, value: unknown) => { preferences[key] = value; },
  userPreferencesLoadedFromServer: () => loadedFromServer,
}));

const { loadClaudeRules, readCachedClaudeRules, readRulesNotCarried, saveClaudeRules } = await import('@/shared/claudePermissionRules');

const source = (overrides: Partial<ClaudeSettingsPermissionSource> = {}): ClaudeSettingsPermissionSource => ({
  scope: 'user',
  path: '/home/me/.claude/settings.json',
  status: 'ok',
  allow: [],
  deny: [],
  ask: [],
  ...overrides,
});

const respondWith = (sources: ClaudeSettingsPermissionSource[]) => {
  claudeSettingsPermissions.mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { sources } }), { status: 200 }),
  );
};

const cached = () => preferences.claudePermissions as Record<string, unknown> | undefined;

beforeEach(() => {
  preferences = {};
  loadedFromServer = true;
  claudeSettingsPermissions.mockReset();
  saveClaudeSettingsPermissions.mockReset();
  saveClaudeSettingsPermissions.mockImplementation((delta) => {
    const apply = (before: string[], one: { add: string[]; remove: string[] }) =>
      [...before.filter((rule) => !one.remove.includes(rule)), ...one.add];
    const cachedNow = (preferences.claudePermissions ?? {}) as { allowedTools?: string[]; disallowedTools?: string[] };
    const saved = {
      allow: apply(cachedNow.allowedTools ?? [], delta.allow),
      deny: apply(cachedNow.disallowedTools ?? [], delta.deny),
    };
    return Promise.resolve(new Response(JSON.stringify({ success: true, data: { source: source(saved) } }), { status: 200 }));
  });
});

describe('loadClaudeRules', () => {
  it('takes the settings file as the rules and caches them', async () => {
    respondWith([source({ allow: ['Read'], deny: ['Bash(rm:*)'] }), source({ scope: 'managed', deny: ['WebSearch'] })]);

    const rules = await loadClaudeRules();

    expect(rules).toEqual({ allow: ['Read'], deny: ['Bash(rm:*)'] });
    expect(cached()).toMatchObject({ allowedTools: ['Read'], disallowedTools: ['Bash(rm:*)'] });
  });

  it('sets a list built before the move aside for review, and never writes it to the file', async () => {
    // Built up by "Allow & remember" in this UI alone. The file is obeyed by the
    // terminal and every synced machine too, so promoting `Edit` into it would
    // approve every file edit everywhere.
    preferences.claudePermissions = {
      allowedTools: ['Read', 'Edit', 'mcp__unity-vov__scene-save'],
      disallowedTools: ['Bash(rm:*)'],
      skipPermissions: true,
    };
    respondWith([source({ allow: ['Read'] })]);

    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });

    expect(saveClaudeSettingsPermissions).not.toHaveBeenCalled();
    expect(readRulesNotCarried()).toEqual({ allow: ['Edit', 'mcp__unity-vov__scene-save'], deny: ['Bash(rm:*)'] });
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    // The session toggle is not a rule, so it is untouched.
    expect(cached()).toMatchObject({ skipPermissions: true });
    expect(preferences.claudeRulesMigrated).toBe(true);
  });

  it('writes nothing at all when the preferences did not load from the server', async () => {
    // After a failed fetch the cache is empty or stale; writing from it would
    // overwrite the very list that is meant to be kept.
    loadedFromServer = false;
    preferences.claudePermissions = { allowedTools: [], disallowedTools: [] };
    respondWith([source({ allow: ['Read'] })]);

    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(preferences.claudeRulesMigrated).toBeUndefined();
    expect(readCachedClaudeRules()).toEqual({ allow: [], deny: [] });
  });

  it('leaves the cache alone when the file cannot be read', async () => {
    preferences.claudePermissions = { allowedTools: ['Read'], disallowedTools: [] };
    respondWith([source({ status: 'invalid' })]);

    expect(await loadClaudeRules()).toBeNull();
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(saveClaudeSettingsPermissions).not.toHaveBeenCalled();
  });

  it('leaves the cache alone when the request itself fails', async () => {
    preferences.claudePermissions = { allowedTools: ['Read'], disallowedTools: [] };
    claudeSettingsPermissions.mockRejectedValue(new Error('offline'));

    expect(await loadClaudeRules()).toBeNull();
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
  });

  it('once reconciled, the file is taken as it stands and nothing more is set aside', async () => {
    preferences.claudeRulesMigrated = true;
    preferences.claudePermissions = { allowedTools: ['Read', 'Stale'], disallowedTools: [] };
    respondWith([source({ allow: ['Read'] })]);

    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(preferences.claudeRulesNotCarried).toBeUndefined();
    expect(saveClaudeSettingsPermissions).not.toHaveBeenCalled();
  });
});

describe('saveClaudeRules', () => {
  it('sends the change rather than the list, and caches what the file reports back', async () => {
    preferences.claudePermissions = { allowedTools: ['Read'], disallowedTools: [] };

    expect(await saveClaudeRules({ allow: ['Read', 'WebSearch'], deny: ['Write'] })).toBe(true);

    expect(saveClaudeSettingsPermissions).toHaveBeenCalledWith({
      allow: { add: ['WebSearch'], remove: [] },
      deny: { add: ['Write'], remove: [] },
    });
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read', 'WebSearch'], deny: ['Write'] });
  });

  it('a rule another machine added between the read and the save survives', async () => {
    preferences.claudePermissions = { allowedTools: ['Read'], disallowedTools: [] };
    // The file gained `WebFetch` since this client last read it.
    saveClaudeSettingsPermissions.mockImplementation((delta) => {
      const after = [...['Read', 'WebFetch'].filter((r) => !delta.allow.remove.includes(r)), ...delta.allow.add];
      return Promise.resolve(new Response(
        JSON.stringify({ success: true, data: { source: source({ allow: after }) } }), { status: 200 },
      ));
    });

    await saveClaudeRules({ allow: ['Read', 'WebSearch'], deny: [] });

    expect(readCachedClaudeRules().allow).toEqual(['Read', 'WebFetch', 'WebSearch']);
  });

  it('reports a failed write instead of caching rules the file never took', async () => {
    preferences.claudePermissions = { allowedTools: [], disallowedTools: [] };
    saveClaudeSettingsPermissions.mockRejectedValue(new Error('read-only file system'));

    expect(await saveClaudeRules({ allow: ['Read'], deny: [] })).toBe(false);
    expect(readCachedClaudeRules()).toEqual({ allow: [], deny: [] });
  });
});
