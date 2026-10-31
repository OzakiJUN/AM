// Appearance settings: light / dark, accent colour, background image, font
// size. Kept per device (not synced to the server).
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Mode = 'light' | 'dark' | 'system';

export const ACCENTS: { name: string; color: string }[] = [
  { name: '樱粉', color: '#ee5b9a' },
  { name: '薰衣草', color: '#8b6cf0' },
  { name: '海盐蓝', color: '#3a8ddf' },
  { name: '薄荷', color: '#1fae93' },
  { name: '橘子', color: '#f28b30' },
  { name: '朝阳蓝', color: '#2f4fa8' },
];

/** frosted = blurred and a little more colourful; clear = plain glass; tinted = glass with the accent colour; solid = no glass. */
export type GlassStyle = 'frosted' | 'clear' | 'tinted' | 'solid';

export const GLASS_STYLES: { value: GlassStyle; label: string }[] = [
  { value: 'frosted', label: '磨砂' },
  { value: 'clear', label: '清透' },
  { value: 'tinted', label: '染色' },
  { value: 'solid', label: '不透明' },
];

export const GLASS_DEFAULTS = { glassStyle: 'frosted' as GlassStyle, glassOpacity: 0.74, glassBlur: 22 };

export interface ThemeState {
  mode: Mode;
  accent: string;
  /** Background image as a data URL, or '' for the built-in gradient. */
  background: string;
  /** Blur of the background image in px (0–30). */
  bgBlur: number;
  /** How much the background image is dimmed (0–0.8), for readability. */
  bgDim: number;
  /** Font size multiplier (0.85–1.25). */
  fontScale: number;
  /** Look of the panels on the background (styles.css `glass`). */
  glassStyle: GlassStyle;
  /** How opaque the panels are (0.2–1): lower shows more background, higher keeps text easy to read. */
  glassOpacity: number;
  /** Blur behind the panels in px (0–40). */
  glassBlur: number;
  set: (patch: Partial<Omit<ThemeState, 'set'>>) => void;
}

export const useTheme = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      accent: ACCENTS[0].color,
      background: '',
      bgBlur: 0,
      bgDim: 0.25,
      fontScale: 1,
      ...GLASS_DEFAULTS,
      set: (patch) => set(patch),
    }),
    { name: 'am-theme' },
  ),
);

function prefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/** Applies the theme to the document; call on start and on every change. */
export function applyTheme(t: ThemeState) {
  const root = document.documentElement;
  const dark = t.mode === 'dark' || (t.mode === 'system' && prefersDark());
  root.classList.toggle('dark', dark);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--font-scale', String(t.fontScale));
  root.style.setProperty('--bg-blur', `${t.bgBlur}px`);
  root.style.setProperty('--bg-dim', String(t.bgDim));
  for (const [k, v] of Object.entries(glassVars(t))) root.style.setProperty(k, v);
}

/** CSS variables for the panels (pure; styles.css `glass` / `glass-strong` read them). */
export function glassVars(t: Pick<ThemeState, 'glassStyle' | 'glassOpacity' | 'glassBlur'>): Record<string, string> {
  const style = t.glassStyle ?? GLASS_DEFAULTS.glassStyle;
  const solid = style === 'solid';
  const a = solid ? 1 : Math.min(1, Math.max(0.2, t.glassOpacity ?? GLASS_DEFAULTS.glassOpacity));
  const blur = solid ? 0 : Math.min(40, Math.max(0, t.glassBlur ?? GLASS_DEFAULTS.glassBlur));
  return {
    '--glass-a': a.toFixed(2),
    // Dialogs and menus stay a bit more solid than the panels.
    '--glass-a-strong': Math.min(1, a + 0.16).toFixed(2),
    '--glass-blur': `${blur}px`,
    '--glass-sat': style === 'frosted' ? '1.4' : '1',
    '--glass-tint': style === 'tinted' ? '14%' : '0%',
  };
}

export function watchTheme() {
  applyTheme(useTheme.getState());
  useTheme.subscribe(applyTheme);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useTheme.getState()));
}

/** Reads an image file and returns it as a data URL, shrunk so it stays small enough to keep locally. */
export async function imageFileToDataURL(file: File, maxSide = 2560): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}
