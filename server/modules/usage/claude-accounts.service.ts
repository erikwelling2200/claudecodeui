import crypto from 'node:crypto';

import { CLAUDE_OAUTH_API_HEADERS, createClaudeOAuthSignIn, refreshClaudeOAuthToken } from './claude-oauth.js';
import { parseUsageCache } from './usage.service.js';
import type { UsageLimit } from './usage.service.js';

/** The CLI's own `claude /login`, which is always in the order and cannot be removed here. */
export const CLAUDE_LOGIN_ACCOUNT_ID = 'login';

type StoredAccount = {
  id: string;
  label: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  /** The last renewal failed for good; the account is skipped until it is signed in again. */
  signInRequired?: boolean;
};

type ClaudeAccountsDependencies = {
  config: { get(key: string): string | null; set(key: string, value: string): void };
  fetch: typeof globalThis.fetch;
  /** The email of the CLI's own login, from `~/.claude.json`, so the same account is not added twice. */
  loginEmail: () => string | null;
  now?: () => number;
};

/** One subscription in the order runs try them, as the settings list shows it. */
export type ClaudeAccountSummary = {
  id: string;
  label: string;
  kind: 'login' | 'oauth';
  signInRequired: boolean;
  /** This account's own limit bars; the CLI login's come from the usage service instead. */
  limits: UsageLimit[];
  usageFetchedAt: number;
};

const ACCOUNTS_KEY = 'claude_accounts';
const ORDER_KEY = 'claude_account_order';
// Runs bill to the plan through this token, and the usage bars need the profile scope.
const SCOPE = 'user:inference user:profile';
// A token is renewed this long before it expires, so a process launched with it keeps working for hours.
const RENEW_BEFORE_MS = 3 * 3_600_000;
const MAINTAIN_INTERVAL_MS = 5 * 60_000;
// The usage endpoint is tightly rate limited, like the CLI login's reading.
const USAGE_REFRESH_MS = 10 * 60_000;

/**
 * Keeps the extra Claude subscriptions runs can be billed to, in the user's order: their OAuth tokens (renewed in
 * the background), each one's usage bars, and the sign-in that adds one.
 */
export function createClaudeAccountsService(dependencies: ClaudeAccountsDependencies) {
  const now = dependencies.now ?? Date.now;
  const { config } = dependencies;
  const signIn = createClaudeOAuthSignIn({ fetch: dependencies.fetch, now, scope: SCOPE });
  const usage = new Map<string, { limits: UsageLimit[]; fetchedAt: number }>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function readAccounts(): StoredAccount[] {
    try {
      const parsed = JSON.parse(config.get(ACCOUNTS_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAccounts(accounts: StoredAccount[]): void {
    config.set(ACCOUNTS_KEY, JSON.stringify(accounts));
  }

  /** Every account id once, the CLI login included: the stored order first, then anything it misses. */
  function order(): string[] {
    let stored: string[] = [];
    try {
      const parsed = JSON.parse(config.get(ORDER_KEY) || '[]');
      if (Array.isArray(parsed)) stored = parsed.filter((id) => typeof id === 'string');
    } catch {
      stored = [];
    }
    const known = [CLAUDE_LOGIN_ACCOUNT_ID, ...readAccounts().map((account) => account.id)];
    return [...stored.filter((id) => known.includes(id)), ...known.filter((id) => !stored.includes(id))].filter((id, index, ids) => ids.indexOf(id) === index);
  }

  function setOrder(ids: string[]): void {
    const known = order();
    if (ids.length !== known.length || !known.every((id) => ids.includes(id))) throw new Error('The order must name every account once');
    config.set(ORDER_KEY, JSON.stringify(ids));
  }

  /** The token a run on this account is launched with, or null when it cannot be used now. */
  function token(id: string): string | null {
    const account = readAccounts().find((entry) => entry.id === id);
    if (!account || account.signInRequired) return null;
    if (account.expiresAt && account.expiresAt <= now()) return null;
    return account.accessToken;
  }

  function label(id: string): string {
    if (id === CLAUDE_LOGIN_ACCOUNT_ID) return dependencies.loginEmail() ?? 'Claude login';
    return readAccounts().find((account) => account.id === id)?.label ?? id;
  }

  function limits(id: string): UsageLimit[] {
    return usage.get(id)?.limits ?? [];
  }

  async function fetchProfileEmail(accessToken: string): Promise<string | null> {
    const response = await dependencies.fetch('https://api.anthropic.com/api/oauth/profile', { headers: { ...CLAUDE_OAUTH_API_HEADERS, Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) return null;
    const body: any = await response.json().catch(() => null);
    return body?.account?.email_address ?? body?.account?.email ?? null;
  }

  async function completeSignIn(pasted: string): Promise<void> {
    const entry = await signIn.complete(pasted);
    const email = await fetchProfileEmail(entry.accessToken);
    const accounts = readAccounts();
    if (email && email === dependencies.loginEmail()) throw new Error(`${email} is the Claude login already. Sign in to the other account in the browser first.`);
    const existing = email ? accounts.find((account) => account.label === email) : undefined;
    const account: StoredAccount = {
      id: existing?.id ?? crypto.randomUUID(),
      label: email ?? `Account ${accounts.length + 2}`,
      accessToken: entry.accessToken,
      refreshToken: entry.refreshToken,
      expiresAt: entry.expiresAt,
    };
    writeAccounts(existing ? accounts.map((stored) => (stored.id === existing.id ? account : stored)) : [...accounts, account]);
    await refreshUsage(account.id).catch(() => undefined);
  }

  function remove(id: string): void {
    if (id === CLAUDE_LOGIN_ACCOUNT_ID) throw new Error('The Claude login cannot be removed here');
    writeAccounts(readAccounts().filter((account) => account.id !== id));
    usage.delete(id);
  }

  async function renew(account: StoredAccount): Promise<void> {
    if (!account.refreshToken || account.signInRequired) return;
    try {
      const renewed = await refreshClaudeOAuthToken(dependencies.fetch, account.refreshToken, SCOPE, now);
      writeAccounts(readAccounts().map((stored) => (stored.id === account.id ? { ...stored, ...renewed, signInRequired: false } : stored)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeAccounts] Renewing ${account.label} failed: ${message}`);
      // A 4xx is a refresh token the server will never take again; anything else is retried on the next pass.
      if (/^HTTP 4\d\d/.test(message)) writeAccounts(readAccounts().map((stored) => (stored.id === account.id ? { ...stored, signInRequired: true } : stored)));
    }
  }

  async function refreshUsage(id: string): Promise<void> {
    const accessToken = token(id);
    if (!accessToken) return;
    const response = await dependencies.fetch('https://api.anthropic.com/api/oauth/usage', { headers: { ...CLAUDE_OAUTH_API_HEADERS, Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reading = parseUsageCache({ body: await response.json(), fetchedAt: now() });
    usage.set(id, { limits: reading.limits, fetchedAt: reading.fetchedAt });
  }

  /** Refetches every extra account's usage now; a failed one keeps its last reading. */
  async function refreshAllUsage(): Promise<void> {
    await Promise.all(readAccounts().map((account) => refreshUsage(account.id).catch(() => undefined)));
  }

  /** Renews tokens close to expiry and refetches usage readings older than their interval. */
  async function maintain(): Promise<void> {
    for (const account of readAccounts()) {
      if (account.expiresAt && account.expiresAt - now() < RENEW_BEFORE_MS) await renew(account);
      if (now() - (usage.get(account.id)?.fetchedAt ?? 0) >= USAGE_REFRESH_MS) {
        await refreshUsage(account.id).catch((error: unknown) => {
          console.warn(`[ClaudeAccounts] Usage for ${account.label} failed: ${error instanceof Error ? error.message : error}`);
        });
      }
    }
  }

  function start(): void {
    stop();
    void maintain();
    timer = setInterval(() => void maintain(), MAINTAIN_INTERVAL_MS);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function list(): ClaudeAccountSummary[] {
    const accounts = readAccounts();
    return order().map((id) => {
      const stored = accounts.find((account) => account.id === id);
      return {
        id,
        label: label(id),
        kind: id === CLAUDE_LOGIN_ACCOUNT_ID ? 'login' : 'oauth',
        signInRequired: Boolean(stored?.signInRequired),
        limits: limits(id),
        usageFetchedAt: usage.get(id)?.fetchedAt ?? 0,
      };
    });
  }

  return { order, setOrder, token, label, limits, list, startSignIn: signIn.start, completeSignIn, remove, refreshUsage, refreshAllUsage, start, stop };
}
