import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';

import { Button } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';

type CsharpServerInstallStatus = {
  source: 'environment' | 'cloudcli' | 'editorExtension' | null;
  executablePath: string | null;
  installedVersion: string | null;
  missingRuntime: string | null;
  installing: boolean;
  error: string | null;
};

const INSTALL_POLL_INTERVAL_MS = 1500;

/** Rendered by Settings for the "languages" tab, which installs the Roslyn server behind the code editor's C# support. */
export default function LanguagesSettingsTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<CsharpServerInstallStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const response = await api.csharpLanguage.serverInstallStatus();
    setStatus((await readApiJson<{ data: CsharpServerInstallStatus }>(response)).data);
  }, []);

  useEffect(() => {
    void loadStatus().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [loadStatus]);

  // The download runs on the server, so its progress is followed by polling until it ends.
  useEffect(() => {
    if (!status?.installing) return undefined;
    const timer = setTimeout(() => {
      void loadStatus().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, INSTALL_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [loadStatus, status]);

  const install = async () => {
    setError(null);
    try {
      const response = await api.csharpLanguage.installServer();
      setStatus((await readApiJson<{ data: CsharpServerInstallStatus }>(response)).data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sourceLabel = (() => {
    if (!status) return t('languagesSettings.csharp.checking', { defaultValue: 'Checking' });
    if (status.source === 'cloudcli') return t('languagesSettings.csharp.sourceCloudcli', { version: status.installedVersion, defaultValue: 'Installed ({{version}})' });
    if (status.source === 'editorExtension') return t('languagesSettings.csharp.sourceEditorExtension', { defaultValue: 'From the VS Code C# extension' });
    if (status.source === 'environment') return t('languagesSettings.csharp.sourceEnvironment', { defaultValue: 'From ROSLYN_LANGUAGE_SERVER_PATH' });
    return t('languagesSettings.csharp.notInstalled', { defaultValue: 'Not installed' });
  })();
  const shownError = error ?? status?.error ?? null;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('languagesSettings.csharp.title', { defaultValue: 'C#' })}>
        <SettingsCard divided>
          <SettingsRow
            label={t('languagesSettings.csharp.serverLabel', { defaultValue: 'C# language server' })}
            description={status?.executablePath ?? sourceLabel}
          >
            <div className="flex flex-shrink-0 items-center gap-3">
              {status?.executablePath && <span className="text-xs text-muted-foreground">{sourceLabel}</span>}
              <Button type="button" size="sm" onClick={() => void install()} disabled={!status || status.installing}>
                {status?.installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {status?.installing
                  ? t('languagesSettings.csharp.installing', { defaultValue: 'Installing' })
                  : status?.installedVersion
                    ? t('languagesSettings.csharp.update', { defaultValue: 'Update' })
                    : t('languagesSettings.csharp.install', { defaultValue: 'Install' })}
              </Button>
            </div>
          </SettingsRow>

          {(status?.missingRuntime || shownError) && (
            <div className="space-y-2 px-4 py-4">
              {status?.missingRuntime && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                  {t('languagesSettings.csharp.missingRuntime', {
                    runtime: status.missingRuntime,
                    defaultValue: 'Needs the {{runtime}} runtime, which is not installed. Get it from dotnet.microsoft.com.',
                  })}
                </div>
              )}
              {shownError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                  {shownError}
                </div>
              )}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
