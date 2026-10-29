import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

import { Button } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

type AppendMode = 'off' | 'first' | 'every';

// Mirrors the server's chat-tools settings (server/modules/chat-tools).
type ChatToolsSettings = {
  appendMode: AppendMode;
  appendText: string;
  renameToolEnabled: boolean;
  defaultAppendText: string;
};

const APPEND_MODES: AppendMode[] = ['off', 'first', 'every'];

/** Rendered by Settings for the "messages" tab: text the server appends to user messages, and the agent chat tools. */
export default function MessagesSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<ChatToolsSettings | null>(null);
  const [draftText, setDraftText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.chatTools.settings()
      .then((response) => readApiJson<{ data: ChatToolsSettings }>(response))
      .then((body) => {
        setSettings(body.data);
        setDraftText(body.data.appendText);
      })
      .catch(() => setError(t('messagesSettings.loadFailed')));
  }, [t]);

  const saveSettings = async (changes: Partial<Omit<ChatToolsSettings, 'defaultAppendText'>>) => {
    setIsSaving(true);
    setError(null);
    try {
      const body = await readApiJson<{ data: ChatToolsSettings }>(await api.chatTools.saveSettings(changes));
      setSettings(body.data);
      setDraftText(body.data.appendText);
    } catch {
      setError(t('messagesSettings.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!settings) {
    return error
      ? <div className="text-sm text-red-600 dark:text-red-300">{error}</div>
      : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }

  return (
    <div className="space-y-8">
      <SettingsSection title={t('messagesSettings.sectionTitle')}>
        <SettingsCard divided>
          <SettingsRow label={t('messagesSettings.appendModeLabel')}>
            <select
              value={settings.appendMode}
              disabled={isSaving}
              onChange={(event) => void saveSettings({ appendMode: event.target.value as AppendMode })}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            >
              {APPEND_MODES.map((mode) => (
                <option key={mode} value={mode}>{t(`messagesSettings.appendModes.${mode}`)}</option>
              ))}
            </select>
          </SettingsRow>

          <div className="space-y-2 px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <label htmlFor="chat-tools-append-text" className="text-sm font-medium text-foreground">
                {t('messagesSettings.appendTextLabel')}
              </label>
              {draftText !== settings.defaultAppendText && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isSaving}
                  onClick={() => void saveSettings({ appendText: settings.defaultAppendText })}
                >
                  {t('messagesSettings.resetText')}
                </Button>
              )}
            </div>
            <textarea
              id="chat-tools-append-text"
              value={draftText}
              rows={4}
              disabled={isSaving || settings.appendMode === 'off'}
              onChange={(event) => setDraftText(event.target.value)}
              // Saved on blur so typing does not write the setting on every keystroke.
              onBlur={() => { if (draftText !== settings.appendText) void saveSettings({ appendText: draftText }); }}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
            />
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('messagesSettings.toolsTitle')}>
        <SettingsCard divided>
          <SettingsRow label={t('messagesSettings.renameToolLabel')} description={t('messagesSettings.renameToolDescription')}>
            <SettingsToggle
              checked={settings.renameToolEnabled}
              onChange={(value) => void saveSettings({ renameToolEnabled: value })}
              ariaLabel={t('messagesSettings.renameToolLabel')}
              disabled={isSaving}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {error && <div className="text-sm text-red-600 dark:text-red-300">{error}</div>}
    </div>
  );
}
