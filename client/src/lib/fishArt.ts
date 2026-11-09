// How each species of 星屿鱼塘 looks (docs/fishing.md 美术): everything is
// derived from the catalogue (id, shape, motif, rarity), so the 100 species
// get 100 different, stable looks without any image files. Pure; tested in
// fishArt.test.ts. The drawing is app/FishingArt.tsx.

export interface FishLook {
  shape: 'round' | 'long' | 'whale' | 'star' | 'ray';
  tail: 'fork' | 'fan' | 'lunate' | 'round';
  dorsal: 'sail' | 'spike' | 'wave' | 'tuft';
  /** 0 plain belly, 1 bands, 2 spots, 3 scales, 4 zigzag, 5 stripe, 6 rings, 7 fade, 8 constellation, 9 marble. */
  pattern: number;
  rarity: number;
  hue: number;
  body: string;
  belly: string;
  fin: string;
  accent: string;
  line: string;
  /** Pattern marks: light on dark bodies, dark on light ones. */
  mark: string;
  eye: number;
  cheeks: boolean;
  /** Stable pseudo-random numbers for spot positions etc. (0–1). */
  seeds: number[];
}

/** FNV-1a, so the same id always gives the same look. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Base hue per rarity: warm orange, fresh green, sky blue, violet, gold. */
const RARITY_HUE = [24, 152, 200, 272, 46];
const SHAPES = ['round', 'long', 'whale', 'star', 'ray'] as const;
const TAILS = ['fork', 'fan', 'lunate', 'round'] as const;
const DORSALS = ['sail', 'spike', 'wave', 'tuft'] as const;

const hsl = (h: number, s: number, l: number) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;

export function fishLook(sp: { id: string; shape: string; motif: number; rarity: number }): FishLook {
  const h = hash(sp.id);
  const r = rng(h);
  const rarity = Math.max(0, Math.min(4, sp.rarity | 0));
  // Each species drifts around its rarity's hue so neighbours differ.
  const hue = RARITY_HUE[rarity] + Math.round(r() * 56 - 28);
  const light = 52 + r() * 14;
  const sat = 68 + r() * 20;
  const dark = light < 58;
  const shape = (SHAPES as readonly string[]).includes(sp.shape) ? (sp.shape as FishLook['shape']) : 'round';
  return {
    shape,
    tail: TAILS[(h >>> 3) % 4],
    dorsal: DORSALS[(h >>> 7) % 4],
    pattern: Math.max(0, Math.min(9, sp.motif | 0)),
    rarity,
    hue,
    body: hsl(hue, sat, light),
    belly: hsl(hue + 12, sat - 18, Math.min(92, light + 26)),
    fin: hsl(hue - 14, sat, light - 14),
    accent: hsl(hue + 150 + r() * 60, 80, 66),
    line: hsl(hue, 45, 20),
    mark: dark ? 'rgba(255,255,255,.72)' : hsl(hue, 55, 30),
    eye: 6 + Math.round(r() * 2),
    cheeks: (h >>> 11) % 3 === 0,
    seeds: Array.from({ length: 16 }, () => r()),
  };
}

/** Card frame and tile colours per rarity of the fish (not the card tier). */
export const RARITY_WATER = [
  ['#e9f6f4', '#cde9e3'],
  ['#e5f7ec', '#c4ead2'],
  ['#e3f1fb', '#bfdcf3'],
  ['#efe8fb', '#d8c9f3'],
  ['#fdf5dc', '#f3dfa0'],
];
