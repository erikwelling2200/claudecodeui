import { getConnection } from '@/modules/database/connection.js';
import type { SessionWorktree, SessionWorktreeCheckout } from '@/shared/types.js';

type SessionWorktreeRow = {
  session_id: string;
  unit_key: string;
  unit_name: string;
  suffix: string;
  checkouts_json: string;
  claimed_at: string;
  updated_at: string;
};

function parseCheckouts(raw: string): SessionWorktreeCheckout[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is SessionWorktreeCheckout => (
        typeof entry === 'object' && entry !== null
        && typeof (entry as SessionWorktreeCheckout).repo === 'string'
        && typeof (entry as SessionWorktreeCheckout).path === 'string'
      ))
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: SessionWorktreeRow): SessionWorktree {
  return {
    sessionId: row.session_id,
    unitKey: row.unit_key,
    unitName: row.unit_name,
    suffix: row.suffix,
    checkouts: parseCheckouts(row.checkouts_json),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
  };
}

export const sessionWorktreesDb = {
  listBySession(sessionId: string): SessionWorktree[] {
    const rows = getConnection()
      .prepare('SELECT * FROM session_worktrees WHERE session_id = ? ORDER BY unit_key')
      .all(sessionId) as SessionWorktreeRow[];
    return rows.map(toRecord);
  },

  /**
   * Records the worktree a chat was granted for one unit, replacing the unit's
   * previous row. Returns whether anything changed, so a repeat of the same
   * claim (the hook reports every write) costs no broadcast.
   */
  upsert(input: { sessionId: string; unitKey: string; unitName: string; suffix: string; checkouts: SessionWorktreeCheckout[] }): { changed: boolean } {
    const db = getConnection();
    const checkoutsJson = JSON.stringify(input.checkouts);
    return db.transaction(() => {
      const existing = db
        .prepare('SELECT suffix, checkouts_json FROM session_worktrees WHERE session_id = ? AND unit_key = ?')
        .get(input.sessionId, input.unitKey) as Pick<SessionWorktreeRow, 'suffix' | 'checkouts_json'> | undefined;
      if (existing && existing.suffix === input.suffix && existing.checkouts_json === checkoutsJson) {
        return { changed: false };
      }
      db.prepare(
        `INSERT INTO session_worktrees (session_id, unit_key, unit_name, suffix, checkouts_json, claimed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(session_id, unit_key) DO UPDATE SET
           unit_name = excluded.unit_name,
           suffix = excluded.suffix,
           checkouts_json = excluded.checkouts_json,
           claimed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`
      ).run(input.sessionId, input.unitKey, input.unitName, input.suffix, checkoutsJson);
      return { changed: true };
    })();
  },

  deleteBySession(sessionId: string): void {
    getConnection().prepare('DELETE FROM session_worktrees WHERE session_id = ?').run(sessionId);
  },
};
