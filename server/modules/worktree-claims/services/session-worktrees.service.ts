import { sessionWorktreesDb } from '@/modules/database/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { SessionWorktree, SessionWorktreeClaim } from '@/shared/types.js';

/**
 * Tells every open socket that a chat moved to another worktree. The frame
 * names the session only; a client showing it reads the folders again.
 */
function announceSessionWorktreesChanged(sessionId: string): void {
  const frame = JSON.stringify({ kind: 'session_worktrees_changed', sessionId, timestamp: new Date().toISOString() });
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    try {
      client.send(frame);
    } catch (error) {
      console.error('[SessionWorktrees] Failed to announce a change', { sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** Records a claim the worktree-lock hook granted the chat; the last claim of a unit wins, main included. */
export function recordSessionWorktreeClaim(sessionId: string, claim: SessionWorktreeClaim): void {
  const { changed } = sessionWorktreesDb.upsert({ sessionId, ...claim });
  if (changed) announceSessionWorktreesChanged(sessionId);
}

/**
 * Records the claims the find-worktree script lists for a chat, as a fallback
 * for a claim the hook could not report (the app was down, or the CLI ran
 * without the app's environment). Entries the script reports in another shape
 * are skipped rather than guessed at.
 */
export function recordSessionWorktreeClaims(sessionId: string, claims: unknown): void {
  if (!Array.isArray(claims)) return;
  for (const entry of claims) {
    const claim = entry as { unit?: unknown; unitName?: unknown; suffix?: unknown; repos?: unknown };
    if (typeof claim.unit !== 'string' || typeof claim.suffix !== 'string' || !Array.isArray(claim.repos)) continue;
    const checkouts = claim.repos
      .map((repo) => repo as { repo?: unknown; path?: unknown })
      .filter((repo) => typeof repo.repo === 'string' && typeof repo.path === 'string')
      .map((repo) => ({ repo: repo.repo as string, path: repo.path as string }));
    if (checkouts.length === 0) continue;
    recordSessionWorktreeClaim(sessionId, {
      unitKey: claim.unit,
      unitName: typeof claim.unitName === 'string' ? claim.unitName : claim.unit,
      suffix: claim.suffix,
      checkouts,
    });
  }
}

export function getSessionWorktrees(sessionId: string): SessionWorktree[] {
  return sessionWorktreesDb.listBySession(sessionId);
}
