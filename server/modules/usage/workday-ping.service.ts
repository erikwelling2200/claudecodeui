type WorkdayPingConfig = {
  enabled: boolean;
  /** Local server time, "HH:MM". */
  time: string;
};

type WorkdayPingResult = {
  at: number;
  ok: boolean;
  /** The reply on success, the error on failure. */
  detail: string;
};

type WorkdayPingState = WorkdayPingConfig & {
  /** The local date ("YYYY-MM-DD") of the last workday the ping was attempted, so it goes at most once a day. */
  lastDate: string | null;
  lastResult: WorkdayPingResult | null;
};

type WorkdayPingDependencies = {
  config: { get(key: string): string | null; set(key: string, value: string): void };
  /** Sends one prompt with no context and no tools and resolves with the reply; nothing of the exchange is kept on disk. */
  sendPing: (prompt: string) => Promise<string>;
  now?: () => Date;
};

const CONFIG_KEY = 'claude_workday_ping';
const DEFAULT_STATE: WorkdayPingState = { enabled: false, time: '07:00', lastDate: null, lastResult: null };
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const POLL_INTERVAL_MS = 30_000;
// A server that was down at the set time still sends the ping when it comes back within this long, but not hours later.
const CATCH_UP_MS = 60 * 60 * 1000;

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isWorkday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

/**
 * Builds the optional workday "hi" to Haiku, which starts the plan's five-hour session window at a chosen time
 * instead of at the first real prompt of the day. The schedule is in the server's local time.
 */
export function createWorkdayPingService(dependencies: WorkdayPingDependencies) {
  const now = dependencies.now ?? (() => new Date());
  let timer: ReturnType<typeof setInterval> | null = null;
  let sending = false;

  function read(): WorkdayPingState {
    try {
      return { ...DEFAULT_STATE, ...JSON.parse(dependencies.config.get(CONFIG_KEY) ?? '{}') };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  function write(state: WorkdayPingState): void {
    dependencies.config.set(CONFIG_KEY, JSON.stringify(state));
  }

  function getStatus(): WorkdayPingState {
    return read();
  }

  function setConfig(input: WorkdayPingConfig): WorkdayPingState {
    if (!TIME_PATTERN.test(input.time)) throw new Error('time must be HH:MM');
    const state = { ...read(), enabled: input.enabled, time: input.time };
    // Moving the time later on a day that already pinged should still ping at the new time.
    const [hours, minutes] = state.time.split(':').map(Number);
    const current = now();
    const due = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes);
    if (state.lastDate === localDate(current) && due.getTime() > current.getTime()) state.lastDate = null;
    write(state);
    return state;
  }

  /** Sends the ping when today is a workday, the set time has passed within the catch-up window, and it has not gone yet today. */
  async function tick(): Promise<boolean> {
    if (sending) return false;
    const state = read();
    if (!state.enabled) return false;
    const current = now();
    const today = localDate(current);
    if (!isWorkday(current) || state.lastDate === today) return false;
    const [hours, minutes] = state.time.split(':').map(Number);
    const due = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes).getTime();
    const late = current.getTime() - due;
    if (late < 0 || late > CATCH_UP_MS) return false;

    // Recorded before sending, so a failure or a restart mid-send never makes it go twice in one day.
    write({ ...state, lastDate: today });
    sending = true;
    let result: WorkdayPingResult;
    try {
      result = { at: Date.now(), ok: true, detail: (await dependencies.sendPing('hi')).trim() };
    } catch (error) {
      result = { at: Date.now(), ok: false, detail: error instanceof Error ? error.message : String(error) };
      console.error('[WorkdayPing] Sending failed', { error: result.detail });
    } finally {
      sending = false;
    }
    write({ ...read(), lastResult: result });
    return true;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
    timer.unref?.();
    void tick();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { getStatus, setConfig, tick, start, stop };
}
