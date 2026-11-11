import { Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { ClaudeCreditStatus } from '@/shared/types';
import { formatCreditCycleDay } from '@/shared/utils';

type ClaudeApiCreditProps = {
  textClass: string;
  subtextClass: string;
};

/**
 * Rendered by AccountContent for Claude: the API credit cycle the sidebar totals spend over, and the key that reads
 * the whole organization's cost report. The key is write-only from here; the server only reports its last four characters.
 */
export default function ClaudeApiCredit({ textClass, subtextClass }: ClaudeApiCreditProps) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<ClaudeCreditStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [dayDraft, setDayDraft] = useState('');
  const [amountDraft, setAmountDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (next: ClaudeCreditStatus) => {
    setStatus(next);
    setDayDraft(String(next.renewalDay));
    setAmountDraft(next.amount === null ? '' : String(next.amount));
  };

  useEffect(() => {
    void (async () => {
      const response = await api.usage.claudeCredit();
      if (response.ok) show(await response.json());
    })();
  }, []);

  const apply = async (request: Promise<Response>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await request;
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || response.statusText);
      show(await response.json());
      setKeyDraft('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const since = status ? formatCreditCycleDay(status.cycleStart) : '';
  const cycleChanged = status !== null && (dayDraft !== String(status.renewalDay) || amountDraft !== (status.amount === null ? '' : String(status.amount)));

  return (
    <div className="space-y-2 border-t border-border/50 pt-4" data-testid="claude-api-credit">
      <div className="flex items-center gap-2">
        <Wallet className={`h-4 w-4 ${subtextClass}`} />
        <div className={`font-medium ${textClass}`}>{t('agents.apiCredit.title')}</div>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void apply(api.usage.saveClaudeCreditCycle(Number(dayDraft), amountDraft.trim() ? Number(amountDraft) : null));
        }}
      >
        <label className={`text-sm ${subtextClass}`}>
          <div>{t('agents.apiCredit.renewalDay')}</div>
          <Input type="number" min={1} max={31} value={dayDraft} onChange={(event) => setDayDraft(event.target.value)} className="w-20 bg-background" />
        </label>
        <label className={`text-sm ${subtextClass}`}>
          <div>{t('agents.apiCredit.amount')}</div>
          <Input type="number" min={0} step="any" value={amountDraft} onChange={(event) => setAmountDraft(event.target.value)} className="w-28 bg-background" />
        </label>
        <Button type="submit" size="sm" disabled={saving || !cycleChanged}>{t('agents.apiCredit.saveCycle')}</Button>
      </form>
      <div className={`text-sm ${subtextClass}`}>{t('agents.apiCredit.keyDescription')}</div>
      <div className={`text-sm ${subtextClass}`}>
        {status?.keyHint ? t('agents.apiCredit.keySaved', { hint: status.keyHint }) : t('agents.apiCredit.keyNone')}
        {status?.org && ` · ${t('agents.apiCredit.orgSpend', { amount: `$${status.org.cycle.toFixed(2)}`, since })}`}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (keyDraft.trim()) void apply(api.usage.saveClaudeCreditKey(keyDraft.trim()));
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="sk-ant-..."
          aria-label={t('agents.apiCredit.title')}
          className="bg-background"
        />
        <Button type="submit" size="sm" disabled={saving || !keyDraft.trim()}>
          {status?.keyHint ? t('agents.fallbackKey.replace') : t('agents.fallbackKey.save')}
        </Button>
        {status?.keyHint && (
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void apply(api.usage.removeClaudeCreditKey())}>
            {t('agents.fallbackKey.remove')}
          </Button>
        )}
      </form>
      {(error || status?.error) && <div className="text-sm text-red-600 dark:text-red-400">{error || status?.error}</div>}
    </div>
  );
}
