import fs from 'node:fs';
import path from 'node:path';

import { createClaudeOAuthSignIn } from './claude-oauth.js';

type UsageLoginDependencies = {
  homeDirectory: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
};

// /api/oauth/usage needs only this scope, so the token can read usage but cannot spend quota.
const SCOPE = 'user:profile';

/**
 * Signs in for the dedicated usage token the session-usage skill reads from ~/.claude/usage-token.json, from the
 * browser instead of a terminal. The token's refresh token eventually expires, and then only a new sign-in helps.
 */
export function createUsageLoginService(dependencies: UsageLoginDependencies) {
  const now = dependencies.now ?? Date.now;
  const tokenPath = path.join(dependencies.homeDirectory, '.claude', 'usage-token.json');
  const signIn = createClaudeOAuthSignIn({ fetch: dependencies.fetch, now, scope: SCOPE });

  /** Whether usage.js can use the token as it is now: present, and either unexpired or renewed by its last run. */
  function tokenUsable(): boolean {
    try {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      return !!token.accessToken && !(token.expiresAt && now() >= token.expiresAt);
    } catch {
      return false;
    }
  }

  /** Exchanges the code the callback page showed for a token and saves it where usage.js looks, in the shape usage-auth.js writes. */
  async function complete(pasted: string): Promise<void> {
    const entry = await signIn.complete(pasted);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(entry, null, 1), { mode: 0o600 });
  }

  return { tokenUsable, start: signIn.start, complete };
}
