import { beforeEach, expect, it, vi } from 'vitest';

// "Always allow" in a chat permission prompt has to reach Claude's settings
// file, where the terminal CLI reads it too. The save sends the difference
// against the cached rules, so if the cache were written first that difference
// would be empty and the grant would live only in the cache — gone the next
// time the rules are read back from the file.

type Delta = { allow: { add: string[]; remove: string[] }; deny: { add: string[]; remove: string[] } };
const saveClaudeSettingsPermissions = vi.fn<(delta: Delta) => Promise<Response>>();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: { providers: { saveClaudeSettingsPermissions: (delta: Delta) => saveClaudeSettingsPermissions(delta) } },
}));

let preferences: Record<string, unknown> = {};

vi.mock('@/shared/userSettings', () => ({
  readUserPreference: (key: string, fallback: unknown) => preferences[key] ?? fallback,
  writeUserPreference: (key: string, value: unknown) => { preferences[key] = value; },
}));

const { grantClaudeToolPermission } = await import('@/modules/chat/utils/chatPermissions');

beforeEach(() => {
  preferences = { claudePermissions: { allowedTools: ['Read'], disallowedTools: [], skipPermissions: false } };
  saveClaudeSettingsPermissions.mockReset();
  saveClaudeSettingsPermissions.mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }));
});

it('sends the granted rule to the settings file', () => {
  grantClaudeToolPermission('Bash(git status:*)');

  expect(saveClaudeSettingsPermissions).toHaveBeenCalledWith({
    allow: { add: ['Bash(git status:*)'], remove: [] },
    deny: { add: [], remove: [] },
  });
});

it('also caches the grant at once, so the turn in flight can use it', () => {
  grantClaudeToolPermission('Bash(git status:*)');

  expect((preferences.claudePermissions as { allowedTools: string[] }).allowedTools)
    .toEqual(['Read', 'Bash(git status:*)']);
});
