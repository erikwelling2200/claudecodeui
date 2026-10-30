import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSettingsPermissionSource } from '@/shared/types';

// Claude's rules live in its own settings file so that this UI and the user's
// terminal sessions obey one list, on every machine their settings directory
// is synced to. The preference is only a cache of that file, which these tests
// pin: the file wins on load, a write reaches the file before the cache, and a
// file that cannot be read never reads as "no rules".

const claudeSettingsPermissions = vi.fn<() => Promise<Response>>();
const saveClaudeSettingsPermissions = vi.fn<(rules: { allow: string[]; deny: string[] }) => Promise<Response>>();

// Only the endpoints are stubbed; `readApiJson` stays real so the module parses
// the same envelope the server sends.
vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    providers: {
      claudeSettingsPermissions: () => claudeSettingsPermissions(),
      saveClaudeSettingsPermissions: (rules: { allow: string[]; deny: string[] }) => saveClaudeSettingsPermissions(rules),
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
  saveClaudeSettingsPermissions.mockImplementation((rules) => Promise.resolve(
    new Response(JSON.stringify({ success: true, data: { source: source(rules) } }), { status: 200 }),
  ));
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
    respondWith([source({ allow: ['Read'] })]);

    const rules = await loadClaudeRules();

    expect(saveClaudeSettingsPermissions).toHaveBeenCalledWith({ allow: ['Read', 'WebSearch'], deny: [] });
    expect(rules).toEqual({ allow: ['Read', 'WebSearch'], deny: [] });
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

  it('a rule removed from the file stays removed', async () => {
    preferences.claudePermissions = { allowedTools: ['Read', 'WebSearch'], disallowedTools: [] };
    respondWith([source({ allow: ['Read', 'WebSearch'] })]);
    await loadClaudeRules();

    respondWith([source({ allow: ['Read'] })]);
    expect(await loadClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: [] });
  });
});

describe('saveClaudeRules', () => {
  it('writes the file and caches what the file reports back', async () => {
    expect(await saveClaudeRules({ allow: ['Read'], deny: ['Write'] })).toBe(true);

    expect(saveClaudeSettingsPermissions).toHaveBeenCalledWith({ allow: ['Read'], deny: ['Write'] });
    expect(readCachedClaudeRules()).toEqual({ allow: ['Read'], deny: ['Write'] });
  });

  it('reports a failed write instead of caching rules the file never took', async () => {
    preferences.claudePermissions = { allowedTools: [], disallowedTools: [] };
    saveClaudeSettingsPermissions.mockRejectedValue(new Error('read-only file system'));

    expect(await saveClaudeRules({ allow: ['Read'], deny: [] })).toBe(false);
    expect(readCachedClaudeRules()).toEqual({ allow: [], deny: [] });
  });
});
