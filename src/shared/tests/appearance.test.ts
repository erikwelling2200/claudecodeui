import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  hexToHslTriplet,
  hslTripletToHex,
  parseAppearance,
  resolveBackground,
} from '@/shared/appearance';

describe('parseAppearance', () => {
  it('returns the defaults for a missing value', () => {
    expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps valid fields and replaces only the invalid ones', () => {
    const parsed = parseAppearance({ darkTheme: 'dark', uiFont: 'comic-sans', chatFontSize: 16, backgrounds: { light: '#FFEEDD', dark: 'red' } });
    expect(parsed).toEqual({ ...DEFAULT_APPEARANCE, darkTheme: 'dark', chatFontSize: 16, backgrounds: { light: '#ffeedd' } });
  });
});

describe('colour conversion', () => {
  it('matches the theme backgrounds in index.css', () => {
    expect(hslTripletToHex('0 0% 8%')).toBe('#141414');
    expect(hslTripletToHex('222 18% 10%')).toBe('#15181e');
  });

  it('round-trips a colour through HSL within rounding', () => {
    expect(hslTripletToHex(hexToHslTriplet('#3366cc'))).toBe('#3366cc');
    expect(hexToHslTriplet('#808080')).toBe('0 0% 50%');
  });

  it('throws on malformed input instead of producing a bogus colour', () => {
    expect(() => hexToHslTriplet('red')).toThrow();
    expect(() => hslTripletToHex('hsl(1, 2, 3)')).toThrow();
  });
});

describe('applyAppearance', () => {
  it('sets the variables and the dark-blue class, and clears an override when none applies', () => {
    const root = document.createElement('html');
    const appearance = { ...DEFAULT_APPEARANCE, chatFont: 'merriweather' as const, chatFontSize: 17, backgrounds: { 'dark-blue': '#000000' } };

    applyAppearance(root, appearance, 'dark-blue');
    expect(root.classList.contains('theme-dark-blue')).toBe(true);
    expect(root.style.getPropertyValue('--font-chat')).toContain('Merriweather');
    expect(root.style.getPropertyValue('--chat-font-size')).toBe('17px');
    expect(root.style.getPropertyValue('--background')).toBe('0 0% 0%');

    applyAppearance(root, appearance, 'light');
    expect(root.classList.contains('theme-dark-blue')).toBe(false);
    expect(root.style.getPropertyValue('--background')).toBe('');
  });

  it('resolves to the override or else the theme default', () => {
    expect(resolveBackground({ ...DEFAULT_APPEARANCE, backgrounds: { dark: '#101010' } }, 'dark')).toBe('#101010');
    expect(resolveBackground(DEFAULT_APPEARANCE, 'dark')).toBe('#141414');
  });
});
