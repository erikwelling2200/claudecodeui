import { useCallback, useEffect, useState } from 'react';
import { Loader2, Lock, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { WorktreeCheckoutState, WorktreeLockInfo } from '@/shared/types';
import { Button, Input } from '@/shared/ui';

type WorktreeUnit = {
  key: string;
  name: string;
  kind: 'group' | 'repo';
  repos: string[];
  worktrees: Array<{ suffix: string; repos: WorktreeCheckoutState[]; lock: WorktreeLockInfo | null }>;
};

type CreateJob = {
  state?: 'running' | 'done' | 'failed';
  step?: string;
  error?: string;
  skippedNestedRepos?: string[];
};

type GroupWorktreesListProps = {
  projectId: string;
  // Bumped by the groups editor after a save, so units are re-read.
  refreshToken: number;
};

const JOB_POLL_MS = 1500;

/** The script's `--unit` value: a group's name, or a repo unit's main checkout. */
function unitArgument(unit: WorktreeUnit): string {
  return unit.kind === 'group' ? unit.name : unit.repos[0];
}

/** Branches in one worktree, collapsed when every repo is on the same one. */
function branchSummary(repos: WorktreeCheckoutState[], detached: string): string {
  const branches = [...new Set(repos.filter((repo) => repo.exists !== false).map((repo) => repo.branch || detached))];
  return branches.join(', ');
}

function NewWorktreeForm({ projectId, unit, onCreated }: { projectId: string; unit: WorktreeUnit; onCreated: () => void }) {
  const { t } = useTranslation();
  // Suffix typed for the new worktree.
  const [suffix, setSuffix] = useState('');
  // Suffix of the worktree to copy HEAD and ignored files from; '' is the main checkout.
  const [from, setFrom] = useState('');
  // The running creation, polled until it is done or failed.
  const [jobId, setJobId] = useState<string | null>(null);
  // Last progress the script reported for the running or finished creation.
  const [job, setJob] = useState<CreateJob | null>(null);

  useEffect(() => {
    if (!jobId) return undefined;
    const interval = window.setInterval(async () => {
      try {
        const payload = await readApiJson<{ data: { job: CreateJob | null } }>(await api.worktreeClaims.job(jobId));
        if (!payload.data.job) return;
        setJob(payload.data.job);
        if (payload.data.job.state === 'done' || payload.data.job.state === 'failed') {
          setJobId(null);
          if (payload.data.job.state === 'done') onCreated();
        }
      } catch (error) {
        setJob({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
        setJobId(null);
      }
    }, JOB_POLL_MS);
    return () => window.clearInterval(interval);
  }, [jobId, onCreated]);

  const start = async () => {
    setJob({ state: 'running' });
    try {
      const payload = await readApiJson<{ data: { jobId: string } }>(await api.worktreeClaims.createWorktree(projectId, unitArgument(unit), suffix.trim(), from));
      setJobId(payload.data.jobId);
    } catch (error) {
      setJob({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };

  const isRunning = job?.state === 'running';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          value={suffix}
          onChange={(event) => setSuffix(event.target.value)}
          placeholder={t('worktreeClaims.worktrees.suffixPlaceholder')}
          className="h-8 w-28 font-mono text-xs"
          disabled={isRunning}
        />
        <select
          value={from}
          onChange={(event) => setFrom(event.target.value)}
          className="h-8 rounded-md border border-gray-200 bg-transparent px-2 text-xs dark:border-gray-700"
          disabled={isRunning}
          aria-label={t('worktreeClaims.worktrees.copyFrom')}
        >
          {unit.worktrees.map((worktree) => (
            <option key={worktree.suffix} value={worktree.suffix}>
              {t('worktreeClaims.worktrees.copyFromOption', { worktree: worktree.suffix || 'main' })}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="outline" onClick={() => void start()} disabled={isRunning || !/^[\w.-]+$/.test(suffix.trim())}>
          {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('worktreeClaims.worktrees.create')}
        </Button>
      </div>
      {isRunning && job?.step && <p className="truncate text-xs text-muted-foreground">{job.step}</p>}
      {job?.state === 'failed' && <p className="text-xs text-red-600 dark:text-red-400">{job.error}</p>}
      {job?.state === 'done' && Boolean(job.skippedNestedRepos?.length) && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('worktreeClaims.worktrees.skippedNested', { folders: job.skippedNestedRepos?.join(', ') })}
        </p>
      )}
    </div>
  );
}

/** Lists every group's and lone repo's worktrees with their branches and holders, and adds new ones. */
export default function GroupWorktreesList({ projectId, refreshToken }: GroupWorktreesListProps) {
  const { t } = useTranslation();
  // Units of the project as the find-worktree script lists them.
  const [units, setUnits] = useState<WorktreeUnit[]>([]);
  // True while a listing runs; it calls git in every checkout, so it can take a moment.
  const [isLoading, setIsLoading] = useState(false);
  // Why the listing failed, typically the find-worktree skill not being installed.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const payload = await readApiJson<{ data: { units: WorktreeUnit[] } }>(await api.worktreeClaims.worktrees(projectId));
      setUnits(payload.data.units);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const detached = t('worktreeClaims.detached');
  return (
    <div className="space-y-3">
      <span className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('worktreeClaims.worktrees.title')}
        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </span>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {units.map((unit) => (
        <div key={unit.key} className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
          <div className="text-sm font-medium text-gray-900 dark:text-white">{unit.name}</div>
          <ul className="space-y-1">
            {unit.worktrees.map((worktree) => (
              <li key={worktree.suffix} className="flex items-center gap-2 text-xs">
                <span className="w-16 flex-shrink-0 font-mono text-gray-900 dark:text-gray-100">{worktree.suffix || 'main'}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={worktree.repos.map((repo) => repo.path).join('\n')}>
                  {branchSummary(worktree.repos, detached)}
                </span>
                {worktree.lock && (
                  <span className="flex flex-shrink-0 items-center gap-1 text-amber-600 dark:text-amber-400" title={worktree.lock.sessionId}>
                    <Lock className="h-3 w-3" />
                    {t('worktreeClaims.worktrees.claimed')}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <NewWorktreeForm projectId={projectId} unit={unit} onCreated={load} />
        </div>
      ))}
    </div>
  );
}
