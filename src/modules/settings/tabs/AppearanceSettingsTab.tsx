import { useTranslation } from 'react-i18next';

import { useUiPreferences, useSetUiPreference } from '@/shared/context/UiPreferencesContext';
import { useTheme } from '@/shared/context/ThemeContext';
import type { CodeEditorSettingsState, ProjectSortOrder } from '@/shared/types';
import { CHAT_FONT_IDS, CHAT_FONT_SIZES, DARK_THEME_IDS, FONT_NAMES, UI_FONT_IDS, resolveBackground } from '@/shared/appearance';
import type { DarkThemeId, FontId, ThemeId } from '@/shared/appearance';
import { LanguageSelector } from '@/modules/i18n';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';

const SELECT_CLASS = 'w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary';

/** What the Theme select shows: the dark palettes are listed as themes of their own. */
type ThemeChoice = 'light' | DarkThemeId | 'system';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

/** Rendered by Settings for the "appearance" tab, covering theme, fonts, background, project sorting and code editor preferences. */
export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { themeMode, setThemeMode, themeId, appearance, setAppearance } = useTheme();

  const themeName = (id: ThemeId) => t(id === 'dark-blue' ? 'appearanceSettings.theme.darkBlue' : `appearanceSettings.theme.${id}`);
  const fontName = (id: FontId) => (id === 'system' ? t('appearanceSettings.fontAndColour.systemFont') : FONT_NAMES[id]);
  const themeChoice: ThemeChoice = themeMode === 'dark' ? appearance.darkTheme : themeMode;
  const backgroundOverride = appearance.backgrounds[themeId];

  const chooseTheme = (choice: ThemeChoice) => {
    if (choice === 'dark' || choice === 'dark-blue') {
      setAppearance({ darkTheme: choice });
      setThemeMode('dark');
      return;
    }
    setThemeMode(choice);
  };

  const setBackground = (colour: string | undefined) => {
    const backgrounds = { ...appearance.backgrounds };
    if (colour) backgrounds[themeId] = colour;
    else delete backgrounds[themeId];
    setAppearance({ backgrounds });
  };
  const preferences = useUiPreferences();
  const setPreference = useSetUiPreference();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearanceSettings.theme.label')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.theme.label')}
            description={t('appearanceSettings.theme.description')}
          >
            <select
              value={themeChoice}
              onChange={(event) => chooseTheme(event.target.value as ThemeChoice)}
              aria-label={t('appearanceSettings.theme.label')}
              className={`${SELECT_CLASS} sm:w-36`}
            >
              <option value="light">{t('appearanceSettings.theme.light')}</option>
              <option value="dark">{t('appearanceSettings.theme.dark')}</option>
              <option value="dark-blue">{t('appearanceSettings.theme.darkBlue')}</option>
              <option value="system">{t('appearanceSettings.theme.system')}</option>
            </select>
          </SettingsRow>

          {themeMode === 'system' && (
            <SettingsRow label={t('appearanceSettings.theme.systemDarkLabel')}>
              <select
                value={appearance.darkTheme}
                onChange={(event) => setAppearance({ darkTheme: event.target.value as DarkThemeId })}
                aria-label={t('appearanceSettings.theme.systemDarkLabel')}
                className={`${SELECT_CLASS} sm:w-36`}
              >
                {DARK_THEME_IDS.map((id) => <option key={id} value={id}>{themeName(id)}</option>)}
              </select>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.fontAndColour.section')}>
        <SettingsCard divided>
          <SettingsRow label={t('appearanceSettings.fontAndColour.uiFont')}>
            <select
              value={appearance.uiFont}
              onChange={(event) => setAppearance({ uiFont: event.target.value as FontId })}
              aria-label={t('appearanceSettings.fontAndColour.uiFont')}
              className={`${SELECT_CLASS} sm:w-48`}
            >
              {UI_FONT_IDS.map((id) => <option key={id} value={id}>{fontName(id)}</option>)}
            </select>
          </SettingsRow>

          <SettingsRow label={t('appearanceSettings.fontAndColour.chatFont')}>
            <select
              value={appearance.chatFont}
              onChange={(event) => setAppearance({ chatFont: event.target.value as FontId })}
              aria-label={t('appearanceSettings.fontAndColour.chatFont')}
              className={`${SELECT_CLASS} sm:w-48`}
            >
              {CHAT_FONT_IDS.map((id) => <option key={id} value={id}>{fontName(id)}</option>)}
            </select>
          </SettingsRow>

          <SettingsRow label={t('appearanceSettings.fontAndColour.chatFontSize')}>
            <select
              value={appearance.chatFontSize}
              onChange={(event) => setAppearance({ chatFontSize: Number(event.target.value) })}
              aria-label={t('appearanceSettings.fontAndColour.chatFontSize')}
              className={`${SELECT_CLASS} sm:w-28`}
            >
              {CHAT_FONT_SIZES.map((size) => <option key={size} value={size}>{size}px</option>)}
            </select>
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.fontAndColour.background')}
            description={t('appearanceSettings.fontAndColour.backgroundFor', { theme: themeName(themeId) })}
          >
            <div className="flex items-center gap-2">
              {backgroundOverride && (
                <button
                  type="button"
                  onClick={() => setBackground(undefined)}
                  className="rounded-lg px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('appearanceSettings.fontAndColour.reset')}
                </button>
              )}
              <input
                type="color"
                value={resolveBackground(appearance, themeId)}
                onChange={(event) => setBackground(event.target.value)}
                aria-label={t('appearanceSettings.fontAndColour.background')}
                className="h-9 w-14 cursor-pointer rounded-lg border border-input bg-card p-1"
              />
            </div>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.keepProjectsExpanded.section', { defaultValue: 'Sidebar' })}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            description={t('appearanceSettings.keepProjectsExpanded.description', { defaultValue: 'Open several projects together and remember them after reloading.' })}
          >
            <SettingsToggle
              checked={preferences.keepProjectsExpanded}
              onChange={(value) => setPreference('keepProjectsExpanded', value)}
              ariaLabel={t('appearanceSettings.keepProjectsExpanded.label', { defaultValue: 'Keep projects expanded' })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
