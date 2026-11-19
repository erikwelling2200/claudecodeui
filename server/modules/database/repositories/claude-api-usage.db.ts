/**
 * Claude API usage repository.
 *
 * The token usage of each response billed to the fallback API key, shaped like a row of Anthropic's usage report so
 * the sidebar can price the minutes that report has not caught up with yet.
 */

import { getConnection } from '@/modules/database/connection.js';

export type ClaudeApiUsageRow = {
  model: string;
  context_window: string;
  service_tier: string;
  speed: string;
  uncached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  server_tool_use: { web_search_requests: number };
};

const DAY_MS = 86_400_000;

export const claudeApiUsageDb = {
  /**
   * Records one response; `at` is epoch milliseconds. The CLI repeats a response once per content block, so a
   * repeat updates the counts and keeps the time it was first seen.
   */
  record(messageId: string, sessionId: string | null, usage: ClaudeApiUsageRow, at: number): void {
    const db = getConnection();
    db.prepare(`
      INSERT INTO claude_api_usage (message_id, session_id, model, context_window, service_tier, speed, uncached_input_tokens, output_tokens,
        cache_read_input_tokens, cache_write_5m_tokens, cache_write_1h_tokens, web_search_requests, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET uncached_input_tokens = excluded.uncached_input_tokens, output_tokens = excluded.output_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens, cache_write_5m_tokens = excluded.cache_write_5m_tokens,
        cache_write_1h_tokens = excluded.cache_write_1h_tokens, web_search_requests = excluded.web_search_requests
    `).run(messageId, sessionId, usage.model, usage.context_window, usage.service_tier, usage.speed, usage.uncached_input_tokens, usage.output_tokens,
      usage.cache_read_input_tokens, usage.cache_creation.ephemeral_5m_input_tokens, usage.cache_creation.ephemeral_1h_input_tokens,
      usage.server_tool_use.web_search_requests, at);
    db.prepare('DELETE FROM claude_api_usage WHERE created_at < ?').run(at - DAY_MS);
  },

  /** Every response recorded at or after `since` (epoch milliseconds). */
  listSince(since: number): ClaudeApiUsageRow[] {
    const db = getConnection();
    const rows = db.prepare('SELECT * FROM claude_api_usage WHERE created_at >= ?').all(since) as Record<string, any>[];
    return rows.map((row) => ({
      model: row.model,
      context_window: row.context_window,
      service_tier: row.service_tier,
      speed: row.speed,
      uncached_input_tokens: row.uncached_input_tokens,
      output_tokens: row.output_tokens,
      cache_read_input_tokens: row.cache_read_input_tokens,
      cache_creation: { ephemeral_5m_input_tokens: row.cache_write_5m_tokens, ephemeral_1h_input_tokens: row.cache_write_1h_tokens },
      server_tool_use: { web_search_requests: row.web_search_requests },
    }));
  },
};
