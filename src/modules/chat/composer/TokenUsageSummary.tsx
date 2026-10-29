import { memo } from 'react';
import { useTranslation } from 'react-i18next';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
  onClick?: () => void;
};

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Rendered by chat's ChatComposer as a ring that fills with the session's
 * context-window usage; hovering shows the percentage and clicking opens the
 * detailed token breakdown.
 */
function TokenUsageSummary({ usage, onClick }: TokenUsageSummaryProps) {
  const { t } = useTranslation();
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;
  const totalTokens = readUsageNumber(usage?.total);
  const fraction = totalTokens > 0 ? Math.min(Math.max(usedTokens / totalTokens, 0), 1) : 0;
  const percent = Math.round(fraction * 100);
  const ringColor = fraction >= 0.9 ? 'text-red-500' : fraction >= 0.75 ? 'text-amber-500' : 'text-primary';

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      title={t('chat:misc.contextUsed', { percent })}
      aria-label={t('chat:misc.showTokenUsage')}
    >
      <svg viewBox="0 0 20 20" className="h-5 w-5 -rotate-90" aria-hidden="true">
        <circle cx="10" cy="10" r={RING_RADIUS} fill="none" strokeWidth="2.5" className="stroke-border" />
        <circle
          cx="10"
          cy="10"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          className={`${ringColor} transition-[stroke-dashoffset] duration-500 ease-out`}
          opacity={fraction > 0 ? 1 : 0}
        />
      </svg>
    </button>
  );
}

/** Memoized: the composer re-renders on every keystroke and this row's numbers only move when a turn ends. */
export default memo(TokenUsageSummary);
