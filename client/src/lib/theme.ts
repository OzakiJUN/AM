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
