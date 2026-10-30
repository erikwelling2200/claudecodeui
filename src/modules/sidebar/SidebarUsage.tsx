import { useCallback, useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';

type UsageLimit = {
  kind: string;
  label: string;
  percent: number;
  severity: 'normal' | 'warning' | 'critical';
  resetsAt: number;
  active: boolean;
};

type UsageSnapshot = {
  limits: UsageLimit[];
  fetchedAt: number;
};

const POLL_INTERVAL_MS = 60_000;
const STALE_USAGE_MS = 15 * 60_000;
const SESSION_WINDOW_MS = 5 * 3_600_000;
const WEEKLY_WINDOW_MS = 7 * 86_400_000;

const FILL_BY_SEVERITY: Record<UsageLimit['severity'], string> = {
  normal: 'bg-muted-foreground/70',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
};

/* How far through its window a limit sits. The fill running short of this zone means spending below pace. */
function windowElapsed(limit: UsageLimit, now: number): number {
  if (!limit.resetsAt) return 0;
  const span = limit.kind === 'session' ? SESSION_WINDOW_MS : WEEKLY_WINDOW_MS;
  return Math.max(0, Math.min(100, Math.round((100 * (span - (limit.resetsAt - now))) / span)));
}

/* Two units, because "2h" hides the difference between 1h31m and 2h29m when pacing against a reset. */
function formatUntil(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/* The reset that matters is the one currently limiting, falling back to the longest-dated limit. */
function pickReset(limits: UsageLimit[]): number {
  const active = limits.find((limit) => limit.active && limit.resetsAt);
  if (active) return active.resetsAt;
  return Math.max(0, ...limits.map((limit) => limit.resetsAt));
}

/** Rendered by SidebarFooter: the Claude plan's session and weekly limits as bars; clicking refetches them. */
export default function SidebarUsage({ t }: { t: TFunction }) {
  // The last reading from the server; null until the first response so nothing renders before there is data.
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  // True while a click-triggered refetch runs, so the footer line can say so and a second click is ignored.
  const [refreshing, setRefreshing] = useState(false);
  // The clock the ages, reset countdowns and pace zones are measured against; advanced on every poll so they keep counting.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const response = await api.usage.get();
    if (response.ok) setUsage(await response.json());
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const response = await api.usage.refresh();
      if (response.ok) setUsage(await response.json());
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };

  if (!usage || usage.limits.length === 0) return null;

  const stale = !usage.fetchedAt || now - usage.fetchedAt > STALE_USAGE_MS;
  const resetsAt = pickReset(usage.limits);
  let status = usage.fetchedAt ? t('usage.asOf', { age: formatAge(now - usage.fetchedAt) }) : t('usage.noReading');
  if (stale && usage.fetchedAt) status += `, ${t('usage.clickToRefresh')}`;
  if (refreshing) status = t('usage.refreshing');
  const tooltip = usage.limits.map((limit) => `${limit.label}: ${limit.percent}% used${limit.resetsAt ? `, ${windowElapsed(limit, now)}% elapsed, resets in ${formatUntil(limit.resetsAt - now)}` : ''}`).join('\n');

  return (
    <button
      type="button"
      onClick={() => void refresh()}
      title={tooltip}
      className={`block w-full px-4 py-2 text-left transition-opacity hover:bg-accent/40 ${stale && !refreshing ? 'opacity-60 hover:opacity-100' : ''}`}
    >
      {usage.limits.map((limit) => (
        <div key={limit.kind} className="mt-1 flex items-center gap-2 first:mt-0">
          <span className={`w-12 flex-none truncate text-[11px] ${limit.active ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>
            {limit.label}
          </span>
          <span className="relative block h-[5px] flex-1 overflow-hidden rounded-full bg-muted">
            <span className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/20" style={{ width: `${windowElapsed(limit, now)}%` }} />
            <span className={`absolute inset-y-0 left-0 rounded-full ${FILL_BY_SEVERITY[limit.severity]}`} style={{ width: `${limit.percent}%` }} />
          </span>
          <span className={`w-8 flex-none text-right text-[11px] ${limit.active ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>
            {limit.percent}%
          </span>
        </div>
      ))}
      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{status}</span>
        {resetsAt > 0 && <span className="flex-none whitespace-nowrap font-bold">{t('usage.resetsIn', { time: formatUntil(resetsAt - now) })}</span>}
      </div>
    </button>
  );
}
