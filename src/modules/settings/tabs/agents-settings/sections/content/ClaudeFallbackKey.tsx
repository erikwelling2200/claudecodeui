import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { ClaudeBillingStatus } from '@/shared/types';

type ClaudeFallbackKeyProps = {
  textClass: string;
  subtextClass: string;
};

/**
 * Rendered by AccountContent for Claude: the Anthropic API key runs fall back to once the subscription hits a
 * limit. The key is write-only from here; the server only ever reports its last four characters.
 */
export default function ClaudeFallbackKey({ textClass, subtextClass }: ClaudeFallbackKeyProps) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<ClaudeBillingStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api.usage.claudeApiKey();
      if (response.ok) setStatus(await response.json());
    })();
  }, []);

  const apply = async (request: Promise<Response>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await request;
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || response.statusText);
      setStatus(await response.json());
      setDraft('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };

  const current = status?.keySource === 'settings'
    ? t('agents.fallbackKey.saved', { hint: status.keyHint })
    : status?.keySource === 'environment'
      ? t('agents.fallbackKey.fromEnvironment', { hint: status.keyHint })
      : t('agents.fallbackKey.none');

  return (
    <div className="space-y-2 border-t border-border/50 pt-4" data-testid="claude-fallback-key">
      <div className="flex items-center gap-2">
        <KeyRound className={`h-4 w-4 ${subtextClass}`} />
        <div className={`font-medium ${textClass}`}>{t('agents.fallbackKey.title')}</div>
      </div>
      <div className={`text-sm ${subtextClass}`}>{t('agents.fallbackKey.description')}</div>
      <div className={`text-sm ${subtextClass}`}>{current}</div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void apply(api.usage.saveClaudeApiKey(draft.trim()));
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="sk-ant-..."
          aria-label={t('agents.fallbackKey.title')}
          className="bg-background"
        />
        <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
          {status?.keySource === 'settings' ? t('agents.fallbackKey.replace') : t('agents.fallbackKey.save')}
        </Button>
        {status?.keySource === 'settings' && (
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void apply(api.usage.removeClaudeApiKey())}>
            {t('agents.fallbackKey.remove')}
          </Button>
        )}
      </form>
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
