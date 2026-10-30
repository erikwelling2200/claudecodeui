/**
 * Claude API spend repository.
 *
 * A ledger of what turns billed to the fallback API key cost, so the sidebar
 * can total it per day and per month.
 */

import { getConnection } from '@/modules/database/connection.js';

export const claudeApiSpendDb = {
  /** Records the cost of one turn; `at` is epoch milliseconds. */
  record(costUsd: number, sessionId: string | null, at: number): void {
    const db = getConnection();
    db.prepare('INSERT INTO claude_api_spend (session_id, cost_usd, created_at) VALUES (?, ?, ?)').run(sessionId, costUsd, at);
  },

  /** Sums the cost of every turn recorded at or after `since` (epoch milliseconds). */
  sumSince(since: number): number {
    const db = getConnection();
    const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM claude_api_spend WHERE created_at >= ?').get(since) as { total: number };
    return row.total;
  },
};
