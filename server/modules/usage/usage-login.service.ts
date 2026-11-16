import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type UsageLoginDependencies = {
  homeDirectory: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
};

// Claude Code's public OAuth client, the same one the session-usage skill's usage-auth.js signs in with.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// Shows the code on a page to copy instead of redirecting to localhost, so signing in works from a browser on another machine.
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// /api/oauth/usage needs only this scope, so the token can read usage but cannot spend quota.
const SCOPE = 'user:profile';

// A started sign-in is abandoned after this long, so a stale verifier is never exchanged.
const PENDING_TTL_MS = 15 * 60 * 1000;

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/* The callback page shows "code#state"; a pasted callback URL carries both as query parameters. */
function parsePastedCode(input: string): { code: string; state: string | null } {
  const trimmed = input.trim();
  if (/^https?:\/\//.test(trimmed)) {
    const url = new URL(trimmed);
    return { code: url.searchParams.get('code')?.split('#')[0] ?? '', state: url.searchParams.get('state') };
  }
  const [code, state] = trimmed.split('#');
  return { code, state: state || null };
}

/**
 * Signs in for the dedicated usage token the session-usage skill reads from ~/.claude/usage-token.json, from the
 * browser instead of a terminal. The token's refresh token eventually expires, and then only a new sign-in helps.
 */
export function createUsageLoginService(dependencies: UsageLoginDependencies) {
  const now = dependencies.now ?? Date.now;
  const tokenPath = path.join(dependencies.homeDirectory, '.claude', 'usage-token.json');
  let pending: { verifier: string; state: string; startedAt: number } | null = null;

  /** Whether usage.js can use the token as it is now: present, and either unexpired or renewed by its last run. */
  function tokenUsable(): boolean {
    try {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      return !!token.accessToken && !(token.expiresAt && now() >= token.expiresAt);
    } catch {
      return false;
    }
  }

  /** Starts a sign-in and returns the authorize URL to open; only the most recent one can be completed. */
  function start(): { url: string } {
    const verifier = base64Url(crypto.randomBytes(32));
    // 32 bytes: a shorter state is rejected by the authorize endpoint with "Invalid request format".
    const state = base64Url(crypto.randomBytes(32));
    pending = { verifier, state, startedAt: now() };
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}` };
  }

  /** Exchanges the code the callback page showed for a token and saves it where usage.js looks. */
  async function complete(pasted: string): Promise<void> {
    if (!pending || now() - pending.startedAt > PENDING_TTL_MS) throw new Error('No sign-in in progress, start it again');
    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new Error('Paste the code the sign-in page showed');
    if (state && state !== pending.state) throw new Error('That code belongs to an older sign-in, start it again');
    const response = await dependencies.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: pending.verifier,
        state: pending.state,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Sign-in failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    const token = JSON.parse(text);
    pending = null;
    // Same shape usage-auth.js writes, so usage.js reads and renews it the same way.
    const entry = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      expiresAt: token.expires_in ? now() + token.expires_in * 1000 : null,
      scopes: token.scope || SCOPE,
    };
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(entry, null, 1), { mode: 0o600 });
  }

  return { tokenUsable, start, complete };
}
