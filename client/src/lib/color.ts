// Colour helpers for the colour picker (ui/ColorPicker.tsx). Pure, tested.

export interface HSV {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** "#3a8ddf" / "3a8ddf" / "#38d" -> "#3a8ddf"; anything else -> null. */
export function normalizeHex(input: string): string | null {
  let t = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? '#000000';
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv(r: number, g: number, b: number): HSV {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): [number, number, number] {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hexToHsv = (hex: string) => rgbToHsv(...hexToRgb(hex));
export const hsvToHex = (c: HSV) => rgbToHex(...hsvToRgb(c));

/** Pure hue at full saturation and brightness (the picker square's base colour). */
export const hueHex = (h: number) => hsvToHex({ h, s: 1, v: 1 });

/** Readable text colour (black or white) on a background. */
export function onColor(hex: string): '#000000' | '#ffffff' {
  const [r, g, b] = hexToRgb(hex).map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#000000' : '#ffffff';
}

/** Adds a colour to the recent list (newest first, no repeats, at most `max`). */
export function pushRecent(list: string[], hex: string, max = 8): string[] {
  const h = normalizeHex(hex);
  if (!h) return list;
  return [h, ...list.filter((x) => x !== h)].slice(0, max);
}
