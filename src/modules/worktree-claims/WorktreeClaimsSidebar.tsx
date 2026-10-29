import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, Unlock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SessionTasksSection, useSessionTasks } from '@/modules/session-tasks';
import { api, readApiJson } from '@/shared/api';
import type { WorktreeCheckoutState, WorktreeLockInfo } from '@/shared/types';
import { getFolderName } from '@/shared/utils';

type WorktreeClaim = {
  unit: string;
  unitName: string;
  suffix: string;
  lock: WorktreeLockInfo;
  repos: WorktreeCheckoutState[];
};

type WorktreeClaimsSidebarProps = {
  sessionId: string | null;
};

// Claims are taken by the chat's hooks and run out on their own; nothing announces either, so the list is polled.
const REFRESH_INTERVAL_MS = 15000;

/**
 * Rendered by the project-workspace module beside the chat: the task list this
 * chat is keeping, and the worktrees it holds with a release button each.
 */
export function WorktreeClaimsSidebar({ sessionId }: WorktreeClaimsSidebarProps) {
  const { t } = useTranslation();
  const tasks = useSessionTasks(sessionId);
  // The chat's live claims, refreshed on an interval; empty hides the sidebar.
  const [claims, setClaims] = useState<WorktreeClaim[]>([]);
  // `unit + suffix` of the claim whose release request is in flight, to disable its button.
  const [releasingKey, setReleasingKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setClaims([]);
      return;
    }
    try {
      const payload = await readApiJson<{ data: { claims: WorktreeClaim[] } }>(await api.worktreeClaims.claims(sessionId));
      setClaims(payload.data.claims);
    } catch (error) {
      // Without the find-worktree skill installed there are no claims to show.
      console.warn('Could not read worktree claims:', error);
      setClaims([]);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const release = useCallback(async (claim: WorktreeClaim) => {
    setReleasingKey(`${claim.unit}\u0000${claim.suffix}`);
    try {
      await readApiJson(await api.worktreeClaims.release(claim.unit, claim.suffix));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setReleasingKey(null);
      void refresh();
    }
  }, [refresh]);

  if (claims.length === 0 && tasks.length === 0) return null;

  return (
    <aside className="hidden w-64 flex-shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 bg-card/40 p-3 lg:flex">
      {tasks.length > 0 && <SessionTasksSection tasks={tasks} />}
      {claims.length > 0 && (
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('worktreeClaims.sidebar.title')}
        </h2>
      )}
      {claims.map((claim) => {
        const key = `${claim.unit}\u0000${claim.suffix}`;
        return (
          <section key={key} className="rounded-md border border-border/60 bg-background p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground" title={claim.unitName}>{claim.unitName}</div>
                <div className="font-mono text-xs text-muted-foreground">{claim.suffix || 'main'}</div>
              </div>
              <button
                type="button"
                onClick={() => void release(claim)}
                disabled={releasingKey === key}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                title={t('worktreeClaims.sidebar.release')}
                aria-label={t('worktreeClaims.sidebar.release')}
              >
                {releasingKey === key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlock className="h-4 w-4" />}
              </button>
            </div>
            <ul className="mt-2 space-y-1">
              {claim.repos.map((repo) => (
                <li key={repo.path} className="text-xs" title={repo.path}>
                  <div className="truncate text-foreground">{getFolderName(repo.path)}</div>
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <GitBranch className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate font-mono">{repo.branch || t('worktreeClaims.detached')}</span>
                    {Boolean(repo.changedFiles) && (
                      <span className="flex-shrink-0">{t('worktreeClaims.changed', { count: repo.changedFiles })}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {claim.lock.turnEndedAt && (
              <div className="mt-2 text-xs text-muted-foreground">
                {t('worktreeClaims.sidebar.freeAt', { time: new Date(claim.lock.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
              </div>
            )}
          </section>
        );
      })}
    </aside>
  );
}
