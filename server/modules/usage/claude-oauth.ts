import crypto from 'node:crypto';

// Claude Code's public OAuth client, the same one the session-usage skill's usage-auth.js signs in with.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// Shows the code on a page to copy instead of redirecting to localhost, so signing in works from a browser on another machine.
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
// Headers the OAuth-authenticated endpoints under api.anthropic.com want; a plausible client UA is required, its version is not checked.
export const CLAUDE_OAUTH_API_HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-cli/2.1.220 (external, cli)',
  'x-app': 'cli',
  Accept: 'application/json',
};

// A started sign-in is abandoned after this long, so a stale verifier is never exchanged.
const PENDING_TTL_MS = 15 * 60 * 1000;

/** A token as the token endpoint returns it, with `expiresAt` in epoch milliseconds. */
export type ClaudeOAuthToken = { accessToken: string; refreshToken: string | null; expiresAt: number | null; scopes: string };

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

async function requestToken(fetch: typeof globalThis.fetch, now: () => number, body: Record<string, string>, fallbackScope: string, fallbackRefresh: string | null): Promise<ClaudeOAuthToken> {
  const response = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, client_id: CLIENT_ID }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${text.slice(0, 300)}`);
  const token = JSON.parse(text);
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || fallbackRefresh,
    expiresAt: token.expires_in ? now() + token.expires_in * 1000 : null,
    scopes: token.scope || fallbackScope,
  };
}

/**
 * A browser sign-in to a Claude account for `scope`: `start` returns the URL to open, `complete` exchanges the code
 * its callback page showed. Only the most recent sign-in can be completed.
 */
export function createClaudeOAuthSignIn(dependencies: { fetch: typeof globalThis.fetch; now?: () => number; scope: string }) {
  const now = dependencies.now ?? Date.now;
  let pending: { verifier: string; state: string; startedAt: number } | null = null;

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
      scope: dependencies.scope,
      code_challenge: base64Url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
    });
    return { url: `${AUTHORIZE_URL}?${params.toString()}` };
  }

  async function complete(pasted: string): Promise<ClaudeOAuthToken> {
    if (!pending || now() - pending.startedAt > PENDING_TTL_MS) throw new Error('No sign-in in progress, start it again');
    const { code, state } = parsePastedCode(pasted);
    if (!code) throw new Error('Paste the code the sign-in page showed');
    if (state && state !== pending.state) throw new Error('That code belongs to an older sign-in, start it again');
    try {
      const token = await requestToken(dependencies.fetch, now, {
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: pending.verifier, state: pending.state,
      }, dependencies.scope, null);
      pending = null;
      return token;
    } catch (error) {
      throw new Error(`Sign-in failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  return { start, complete };
}

/** Renews an access token; the endpoint may rotate the refresh token, so the result replaces the stored one. */
export function refreshClaudeOAuthToken(fetch: typeof globalThis.fetch, refreshToken: string, scope: string, now: () => number = Date.now): Promise<ClaudeOAuthToken> {
  return requestToken(fetch, now, { grant_type: 'refresh_token', refresh_token: refreshToken }, scope, refreshToken);
}
