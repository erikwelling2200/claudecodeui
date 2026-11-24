import { ChevronDown, ChevronUp, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import { Button, Input } from '@/shared/ui';
import type { ClaudeAccountSummary, ClaudeBillingStatus } from '@/shared/types';

type ClaudeAccountsProps = {
  textClass: string;
  subtextClass: string;
};

type AccountsResponse = { accounts: ClaudeAccountSummary[]; billing: ClaudeBillingStatus };

function formatUntil(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * Rendered by AccountContent for Claude: the subscriptions runs are billed to, in the order they are tried. A run
 * takes the first one not at a limit; the CLI's own login is one of them and cannot be removed here.
 */
export default function ClaudeAccounts({ textClass, subtextClass }: ClaudeAccountsProps) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<AccountsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Open while an account is being added; holds the code pasted from the sign-in page.
  const [signIn, setSignIn] = useState<{ code: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await api.usage.claudeAccounts();
      if (response.ok) setState(await response.json());
    })();
  }, []);

  const apply = async (request: Promise<Response>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await request;
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || response.statusText);
      setState(body);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, offset: number) => {
    if (!state) return;
    const ids = state.accounts.map((account) => account.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + offset, 0, moved);
    void apply(api.usage.saveClaudeAccountOrder(ids));
  };

  const openSignIn = async () => {
    // Opened before the request so the browser treats it as part of the click and does not block it as a popup.
    const tab = window.open('', '_blank');
    const response = await api.usage.startClaudeAccountLogin();
    if (!response.ok) {
      tab?.close();
      setError(`HTTP ${response.status}`);
      return;
    }
    const { url } = await response.json();
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
  };

  const now = Date.now();
  const accounts = state?.accounts ?? [];
  const statusOf = (account: ClaudeAccountSummary) => state?.billing.accounts.find((entry) => entry.id === account.id);

  return (
    <div className="space-y-2 border-t border-border/50 pt-4" data-testid="claude-accounts">
      <div className="flex items-center gap-2">
        <Users className={`h-4 w-4 ${subtextClass}`} />
        <div className={`font-medium ${textClass}`}>{t('agents.accounts.title')}</div>
      </div>
      <ol className="space-y-1">
        {accounts.map((account, index) => {
          const limit = statusOf(account)?.limit;
          const inUse = state?.billing.mode === 'subscription' && state.billing.account?.id === account.id;
          return (
            <li key={account.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-sm" data-testid="claude-account-row">
              <span className={`w-4 flex-none text-right ${subtextClass}`}>{index + 1}</span>
              <span className={`min-w-0 flex-1 truncate ${textClass}`}>{account.label}</span>
              {inUse && <span className="flex-none rounded bg-emerald-500/15 px-1.5 text-xs text-emerald-700 dark:text-emerald-300">{t('agents.accounts.inUse')}</span>}
              {account.signInRequired && <span className="flex-none text-xs text-red-600 dark:text-red-400">{t('agents.accounts.signInRequired')}</span>}
              {!account.signInRequired && limit && (
                <span className="flex-none text-xs text-amber-700 dark:text-amber-300">{t('agents.accounts.limitBackIn', { time: formatUntil(limit.resetsAt - now) })}</span>
              )}
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 flex-none p-0" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={t('agents.accounts.moveUp')}>
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-7 w-7 flex-none p-0" disabled={busy || index === accounts.length - 1} onClick={() => move(index, 1)} aria-label={t('agents.accounts.moveDown')}>
                <ChevronDown className="h-4 w-4" />
              </Button>
              {account.kind === 'oauth' ? (
                <Button type="button" size="sm" variant="ghost" className="h-7 w-7 flex-none p-0" disabled={busy} onClick={() => void apply(api.usage.removeClaudeAccount(account.id))} aria-label={t('agents.accounts.remove')}>
                  <X className="h-4 w-4" />
                </Button>
              ) : (
                <span className="w-7 flex-none" />
              )}
            </li>
          );
        })}
      </ol>
      {signIn ? (
        <div className="space-y-2">
          <div className={`text-sm ${subtextClass}`}>{t('agents.accounts.signInHint')}</div>
          <Button type="button" size="sm" variant="outline" onClick={() => void openSignIn()}>
            {t('agents.accounts.openSignIn')}
          </Button>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!signIn.code.trim()) return;
              void apply(api.usage.completeClaudeAccountLogin(signIn.code.trim())).then((added) => { if (added) setSignIn(null); });
            }}
          >
            <Input
              autoComplete="off"
              spellCheck={false}
              value={signIn.code}
              onChange={(event) => setSignIn({ code: event.target.value })}
              placeholder={t('agents.accounts.pasteCode')}
              aria-label={t('agents.accounts.pasteCode')}
              className="bg-background"
            />
            <Button type="submit" size="sm" disabled={busy || !signIn.code.trim()}>{t('agents.accounts.add')}</Button>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setSignIn(null)}>{t('agents.accounts.cancel')}</Button>
          </form>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setSignIn({ code: '' })}>
          {t('agents.accounts.addAccount')}
        </Button>
      )}
      {error && <div className="break-words text-sm text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
