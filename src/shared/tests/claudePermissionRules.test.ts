import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSettingsPermissionSource } from '@/shared/types';

// Claude's rules live in its own settings file so that this UI and the user's
// terminal sessions obey one list, on every machine their settings directory
// is synced to. The preference is only a cache of that file, which these tests
// pin: the file wins on load, a write reaches the file before the cache, and a
// file that cannot be read never reads as "no rules".

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

vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (key: string, fallback: unknown) => preferences[key] ?? fallback,
  writeUserPreference: (key: string, value: unknown) => { preferences[key] = value; },
}));

const { loadClaudeRules, readCachedClaudeRules, saveClaudeRules } = await import('@/shared/claudePermissionRules');

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

  it('carries a list built before the file was used across into it', async () => {
    preferences.claudePermissions = { allowedTools: ['WebSearch'], disallowedTools: [], skipPermissions: true };
    // This machine has not carried its own list across yet.
    respondWith([source({ allow: ['Read'] })]);
    // The server applies a delta to what the FILE holds, not to this client's cache.
    saveClaudeSettingsPermissions.mockImplementation((delta) => {
      const allow = [...['Read'].filter((rule) => !delta.allow.remove.includes(rule)), ...delta.allow.add];
      return Promise.resolve(new Response(
        JSON.stringify({ success: true, data: { source: source({ allow }) } }), { status: 200 },
      ));
    });

    const rules = await loadClaudeRules();

    // The delta is measured from the file, so it carries the rule being moved.
    expect(saveClaudeSettingsPermissions).toHaveBeenCalledWith({
      allow: { add: ['WebSearch'], remove: [] },
      deny: { add: [], remove: [] },
    });
    expect(rules).toEqual({ allow: ['Read', 'WebSearch'], deny: [] });
    expect(readCachedClaudeRules().allow).toEqual(['Read', 'WebSearch']);
    // The session toggle is not a rule, so it survives the migration untouched.
    expect(cached()).toMatchObject({ skipPermissions: true });
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

  it('a rule removed from the file stays removed, however often the panel saves', async () => {
    preferences.claudePermissions = { allowedTools: ['Read', 'WebSearch'], disallowedTools: [] };
    respondWith([source({ allow: ['Read', 'WebSearch'] })]);
    await loadClaudeRules();

    // A save writes the preference wholesale, which must not re-arm the carry-over.
    preferences.claudePermissions = { allowedTools: ['Read', 'WebSearch'], disallowedTools: [], skipPermissions: false };

    respondWith([source({ allow: ['Read'] })]);
    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(saveClaudeSettingsPermissions).not.toHaveBeenCalled();
  });
});

describe('loadClaudeRules on more than one machine', () => {
  it('a second machine carries its own list across, though the file is already in use', async () => {
    // The file holds the first machine's rules; this machine kept its own list
    // in its own database, and has not carried it across yet.
    preferences.claudePermissions = { allowedTools: ['WebFetch'], disallowedTools: ['Bash(rm:*)'] };
    respondWith([source({ allow: ['Read'], deny: [] })]);
    saveClaudeSettingsPermissions.mockImplementation((delta) => {
      const allow = [...['Read'].filter((rule) => !delta.allow.remove.includes(rule)), ...delta.allow.add];
      const deny = [...delta.deny.add];
      return Promise.resolve(new Response(JSON.stringify({ success: true, data: { source: source({ allow, deny }) } }), { status: 200 }));
    });

    expect(await loadClaudeRules()).toEqual({ allow: ['Read', 'WebFetch'], deny: ['Bash(rm:*)'] });
    expect(preferences.claudeRulesMigrated).toBe(true);
  });

  it('once carried across, the file is taken as it stands', async () => {
    preferences.claudeRulesMigrated = true;
    preferences.claudePermissions = { allowedTools: ['Read', 'Stale'], disallowedTools: [] };
    respondWith([source({ allow: ['Read'] })]);

    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(saveClaudeSettingsPermissions).not.toHaveBeenCalled();
  });

  it('a carry-over that fails to save is tried again next time', async () => {
    preferences.claudePermissions = { allowedTools: ['WebFetch'], disallowedTools: [] };
    respondWith([source({ allow: ['Read'] })]);
    saveClaudeSettingsPermissions.mockRejectedValue(new Error('file locked'));

    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(preferences.claudeRulesMigrated).toBeUndefined();
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
