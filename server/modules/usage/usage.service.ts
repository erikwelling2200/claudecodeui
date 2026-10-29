import fs from 'node:fs';
import path from 'node:path';

type UsageSeverity = 'normal' | 'warning' | 'critical';

type UsageLimit = {
  kind: string;
  label: string;
  percent: number;
  severity: UsageSeverity;
  resetsAt: number;
  active: boolean;
};

type UsageSnapshot = {
  limits: UsageLimit[];
  fetchedAt: number;
};

type UsageServiceDependencies = {
  homeDirectory: string;
  /** Runs the session-usage skill's `usage.js --force`, which writes ~/.claude/usage-cache.json. */
  runUsageScript: (scriptPath: string) => Promise<void>;
  now?: () => number;
};

const EMPTY: UsageSnapshot = { limits: [], fetchedAt: 0 };

// How old a reading may get before a read kicks off a refetch, and how long a failed attempt blocks the next one.
const AUTO_REFRESH_AFTER_MS = 10 * 60 * 1000;

const USAGE_SCRIPT_TAIL = path.join('skills', 'session-usage', 'scripts', 'usage.js');

// The endpoint also returns internal codenames whose meaning is not stable enough to label, and nulls for every
// window the plan does not have, so only these get a bar.
const USAGE_WINDOWS: { key: string; kind: string; label: string; always?: boolean }[] = [
  { key: 'five_hour', kind: 'session', label: 'Session', always: true },
  { key: 'seven_day', kind: 'weekly_all', label: 'Week', always: true },
  { key: 'seven_day_opus', kind: 'weekly_opus', label: 'Opus' },
  { key: 'seven_day_sonnet', kind: 'weekly_sonnet', label: 'Sonnet' },
];

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/* Trust Claude's own severity, but never report "normal" for a bar that is visibly nearly full. */
function severityFor(given: unknown, percent: number): UsageSeverity {
  if (given === 'critical' || percent >= 90) return 'critical';
  if (given === 'warning' || percent >= 75) return 'warning';
  return 'normal';
}

/* The body the session-usage skill stores from /api/oauth/usage, keyed by window name. */
function parseUsageCache(entry: any): UsageSnapshot {
  const body = entry?.body;
  if (!body) return EMPTY;
  const limits: UsageLimit[] = [];
  for (const window of USAGE_WINDOWS) {
    const raw = body[window.key];
    const percent = Number(raw?.utilization);
    if (raw == null || !Number.isFinite(percent)) continue;
    const rounded = clampPercent(percent);
    if (!window.always && rounded === 0) continue; // a plan without this cap reads as a flat zero
    limits.push({
      kind: window.kind,
      label: window.label,
      percent: rounded,
      severity: severityFor(undefined, rounded),
      resetsAt: Date.parse(raw?.resets_at || '') || 0,
      active: rounded > 0,
    });
  }
  if (!limits.length) return EMPTY;
  return { limits, fetchedAt: Number(entry?.fetchedAt || 0) };
}

/* A scoped weekly limit names its model, which is the only way to tell the Opus cap from another model's. */
function labelFor(entry: any): string {
  const model = entry?.scope?.model?.display_name;
  if (model) return String(model);
  if (entry?.kind === 'session') return 'Session';
  if (entry?.kind === 'weekly_all') return 'Week';
  return String(entry?.group || entry?.kind || 'Limit');
}

/* What an interactive Claude Code session caches in ~/.claude.json under cachedUsageUtilization. */
function parseConfigUsage(config: any): UsageSnapshot {
  const cached = config?.cachedUsageUtilization;
  const raw = cached?.utilization?.limits;
  if (!Array.isArray(raw)) return EMPTY;
  const limits: UsageLimit[] = [];
  for (const entry of raw) {
    const percent = Number(entry?.percent);
    if (!Number.isFinite(percent)) continue;
    limits.push({
      kind: String(entry.kind || ''),
      label: labelFor(entry),
      percent: clampPercent(percent),
      severity: severityFor(entry?.severity, percent),
      resetsAt: Date.parse(entry?.resets_at || '') || 0,
      active: !!entry?.is_active,
    });
  }
  return { limits, fetchedAt: Number(cached?.fetchedAtMs || 0) };
}

/* Segment-wise numeric compare, since a plain string sort puts 0.10.0 before 0.2.0. */
function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.split('.').map((part) => parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

function subdirectories(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)); } catch { return []; }
}

/**
 * Builds the usage reader behind the sidebar's limit bars. Two sources, newest wins: the CLI only refreshes
 * ~/.claude.json from an interactive session, so it can be hours old, while the session-usage skill fetches
 * /api/oauth/usage itself into ~/.claude/usage-cache.json.
 */
export function createUsageService(dependencies: UsageServiceDependencies) {
  const now = dependencies.now ?? Date.now;
  const claudeRoot = path.join(dependencies.homeDirectory, '.claude');
  let refreshing: Promise<UsageSnapshot> | null = null;
  let lastAttemptAt = 0;

  function readUsage(): UsageSnapshot {
    const fromScript = parseUsageCache(readJson(path.join(claudeRoot, 'usage-cache.json')));
    const fromConfig = parseConfigUsage(readJson(path.join(dependencies.homeDirectory, '.claude.json')));
    return fromScript.fetchedAt > fromConfig.fetchedAt ? fromScript : fromConfig;
  }

  /* The skill as installed personally or by a plugin: the install manifest first, the newest cached version as fallback. */
  function findUsageScript(): string | null {
    const personal = path.join(claudeRoot, USAGE_SCRIPT_TAIL);
    if (fs.existsSync(personal)) return personal;
    const manifest = readJson(path.join(claudeRoot, 'plugins', 'installed_plugins.json'));
    const entries: any[] = Object.values(manifest?.plugins ?? {}).flat();
    for (const entry of entries) {
      if (typeof entry?.installPath !== 'string') continue;
      const candidate = path.join(entry.installPath, USAGE_SCRIPT_TAIL);
      if (fs.existsSync(candidate)) return candidate;
    }
    const found: { candidate: string; version: string }[] = [];
    for (const owner of subdirectories(path.join(claudeRoot, 'plugins', 'cache'))) {
      for (const plugin of subdirectories(owner)) {
        for (const version of subdirectories(plugin)) {
          const candidate = path.join(version, USAGE_SCRIPT_TAIL);
          if (fs.existsSync(candidate)) found.push({ candidate, version: path.basename(version) });
        }
      }
    }
    found.sort((left, right) => compareVersions(left.version, right.version));
    return found.length ? found[found.length - 1].candidate : null;
  }

  /** Fetches a new reading now. Concurrent callers share one run, since the endpoint is tightly rate limited. */
  function refreshUsage(): Promise<UsageSnapshot> {
    if (refreshing) return refreshing;
    lastAttemptAt = now();
    const scriptPath = findUsageScript();
    if (!scriptPath) return Promise.reject(new Error('The session-usage skill (usage.js) is not installed'));
    refreshing = dependencies.runUsageScript(scriptPath).then(readUsage).finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Returns the current reading, and starts a background refetch when it is older than ten minutes. */
  function getUsage(): UsageSnapshot {
    const usage = readUsage();
    if (!refreshing && now() - Math.max(usage.fetchedAt, lastAttemptAt) >= AUTO_REFRESH_AFTER_MS) refreshUsage().catch(() => undefined);
    return usage;
  }

  return { getUsage, refreshUsage };
}
