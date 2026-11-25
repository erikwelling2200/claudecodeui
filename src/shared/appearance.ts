import { readUserPreference } from '@/shared/userSettings';

/**
 * The Appearance settings beyond light/dark: which dark palette, the interface and
 * chat fonts, the chat text size and a per-theme background override.
 *
 * Kept free of React so parsing and the colour maths are unit-testable; ThemeProvider
 * owns the state and calls {@link applyAppearance}.
 */

/** A colour theme as rendered: the light theme or one of the dark palettes. */
export type ThemeId = 'light' | 'dark' | 'dark-blue';
export type DarkThemeId = Exclude<ThemeId, 'light'>;

export type FontId = 'open-sans' | 'inter' | 'atkinson' | 'encode-sans' | 'merriweather' | 'system';

export type AppearanceSettings = {
  /** The palette dark mode uses, also when the System theme resolves to dark. */
  darkTheme: DarkThemeId;
  uiFont: FontId;
  chatFont: FontId;
  /** In px. */
  chatFontSize: number;
  /** `#rrggbb` per theme; a theme without an entry keeps its own background. */
  backgrounds: Partial<Record<ThemeId, string>>;
};

const SYSTEM_STACK = 'var(--font-system)';

/** CSS stacks; every family here must also be in the Google Fonts link in index.html. */
const FONT_STACKS: Record<FontId, string> = {
  'open-sans': `"Open Sans", ${SYSTEM_STACK}`,
  inter: `Inter, ${SYSTEM_STACK}`,
  atkinson: `"Atkinson Hyperlegible Next", "Open Sans", ${SYSTEM_STACK}`,
  'encode-sans': `"Encode Sans", ${SYSTEM_STACK}`,
  merriweather: 'Merriweather, Georgia, Cambria, "Times New Roman", serif',
  system: SYSTEM_STACK,
};

/** Display names; `system` is translated by the settings tab instead. */
export const FONT_NAMES: Record<Exclude<FontId, 'system'>, string> = {
  'open-sans': 'Open Sans',
  inter: 'Inter',
  atkinson: 'Atkinson Hyperlegible',
  'encode-sans': 'Encode Sans',
  merriweather: 'Merriweather',
};

export const UI_FONT_IDS: FontId[] = ['open-sans', 'inter', 'atkinson', 'encode-sans', 'system'];
export const CHAT_FONT_IDS: FontId[] = ['atkinson', 'open-sans', 'inter', 'merriweather', 'system'];
export const CHAT_FONT_SIZES = [13, 14, 15, 16, 17, 18];
export const DARK_THEME_IDS: DarkThemeId[] = ['dark', 'dark-blue'];

/** Each theme's own `--background` in index.css, as an HSL triplet. */
const THEME_BACKGROUNDS: Record<ThemeId, string> = {
  light: '220 20% 97%',
  dark: '0 0% 8%',
  'dark-blue': '222 18% 10%',
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  darkTheme: 'dark-blue',
  uiFont: 'open-sans',
  chatFont: 'atkinson',
  chatFontSize: 15,
  backgrounds: {},
};

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Reads a stored value, falling back per field so one bad entry does not reset the rest. */
export const parseAppearance = (value: unknown): AppearanceSettings => {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const storedBackgrounds = stored.backgrounds && typeof stored.backgrounds === 'object' ? stored.backgrounds as Record<string, unknown> : {};
  const backgrounds: Partial<Record<ThemeId, string>> = {};
  for (const themeId of Object.keys(THEME_BACKGROUNDS) as ThemeId[]) {
    const colour = storedBackgrounds[themeId];
    if (typeof colour === 'string' && HEX_COLOUR.test(colour)) backgrounds[themeId] = colour.toLowerCase();
  }

  return {
    darkTheme: pick(stored.darkTheme, DARK_THEME_IDS, DEFAULT_APPEARANCE.darkTheme),
    uiFont: pick(stored.uiFont, UI_FONT_IDS, DEFAULT_APPEARANCE.uiFont),
    chatFont: pick(stored.chatFont, CHAT_FONT_IDS, DEFAULT_APPEARANCE.chatFont),
    chatFontSize: pick(stored.chatFontSize, CHAT_FONT_SIZES, DEFAULT_APPEARANCE.chatFontSize),
    backgrounds,
  };
};

export const readStoredAppearance = (): AppearanceSettings => parseAppearance(readUserPreference<unknown>('appearance', null));

/** `#rrggbb` to the `H S% L%` triplet the theme variables use. */
export const hexToHslTriplet = (hex: string): string => {
  if (!HEX_COLOUR.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return `0 0% ${Math.round(lightness * 100)}%`;

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  return `${hue} ${Math.round(saturation * 100)}% ${Math.round(lightness * 100)}%`;
};

/** An `H S% L%` triplet to `#rrggbb`. */
export const hslTripletToHex = (triplet: string): string => {
  const match = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*$/.exec(triplet);
  if (!match) throw new Error(`Not an HSL triplet: ${triplet}`);
  const hue = Number(match[1]);
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    const value = lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

/** The background a theme renders with: the user's override, else the theme's own. */
export const resolveBackground = (appearance: AppearanceSettings, themeId: ThemeId): string =>
  appearance.backgrounds[themeId] ?? hslTripletToHex(THEME_BACKGROUNDS[themeId]);

/** Writes the settings onto the root element as the variables and class index.css reads. */
export const applyAppearance = (root: HTMLElement, appearance: AppearanceSettings, themeId: ThemeId): void => {
  root.classList.toggle('theme-dark-blue', themeId === 'dark-blue');
  root.style.setProperty('--font-ui', FONT_STACKS[appearance.uiFont]);
  root.style.setProperty('--font-chat', FONT_STACKS[appearance.chatFont]);
  root.style.setProperty('--chat-font-size', `${appearance.chatFontSize}px`);

  const override = appearance.backgrounds[themeId];
  if (override) root.style.setProperty('--background', hexToHslTriplet(override));
  else root.style.removeProperty('--background');
};
