import { AlarmClock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsToggle from '@/modules/settings/SettingsToggle';
import { api } from '@/shared/api';
import { Input } from '@/shared/ui';
import type { ClaudeWorkdayPingStatus } from '@/shared/types';

type ClaudeWorkdayPingProps = {
  textClass: string;
  subtextClass: string;
};

/** Rendered by AccountContent for Claude: the switch and time for the server's scheduled workday "hi" to Haiku. */
export default function ClaudeWorkdayPing({ textClass, subtextClass }: ClaudeWorkdayPingProps) {
  const { t, i18n } = useTranslation('settings');
  const [status, setStatus] = useState<ClaudeWorkdayPingStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api.usage.workdayPing();
      if (response.ok) setStatus(await response.json());
    })();
  }, []);

  const save = async (enabled: boolean, time: string) => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.usage.saveWorkdayPing({ enabled, time });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || response.statusText);
      setStatus(await response.json());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  if (!status) return null;
  const last = status.lastResult;
  const when = last ? new Date(last.at).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  return (
    <div className="space-y-2 border-t border-border/50 pt-4" data-testid="claude-workday-ping">
      <div className="flex items-center gap-2">
        <AlarmClock className={`h-4 w-4 ${subtextClass}`} />
        <div className={`font-medium ${textClass}`}>{t('agents.workdayPing.title')}</div>
      </div>
      <div className={`text-sm ${subtextClass}`}>{t('agents.workdayPing.description')}</div>
      <div className="flex items-center gap-3">
        <SettingsToggle
          checked={status.enabled}
          disabled={saving}
          ariaLabel={t('agents.workdayPing.toggle')}
          onChange={(enabled) => void save(enabled, status.time)}
        />
        <Input
          type="time"
          value={status.time}
          disabled={saving}
          aria-label={t('agents.workdayPing.time')}
          onChange={(event) => { if (event.target.value) void save(status.enabled, event.target.value); }}
          className="w-32 bg-background"
        />
      </div>
      {last && (
        <div className={`text-sm ${last.ok ? subtextClass : 'text-red-600 dark:text-red-400'}`}>
          {last.ok
            ? t('agents.workdayPing.lastSent', { when, reply: last.detail })
            : t('agents.workdayPing.lastFailed', { when, error: last.detail })}
        </div>
      )}
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
