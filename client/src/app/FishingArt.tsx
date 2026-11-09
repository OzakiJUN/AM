// 星屿鱼塘's own vector art (docs/fishing.md 美术): fish, cards, badges, tool
// icons and the pond scene. Drawn here, no image files; each species' look
// comes from lib/fishArt.ts.
import { useId, type CSSProperties, type ReactNode } from 'react';
import { CARD_RARITY, cardParts, type FishingRules, type Species } from '@/lib/fishing';
import { fishLook, RARITY_WATER, type FishLook } from '@/lib/fishArt';
import { cx } from '@/ui';

// ---------- fish ----------

const TAIL: Record<FishLook['tail'], string> = {
  fork: 'M0 0 L36 -30 L27 0 L36 30 Z',
  fan: 'M0 0 C16 -32 42 -26 40 0 C42 26 16 32 0 0 Z',
  lunate: 'M0 0 C14 -8 26 -28 38 -34 C30 -12 30 12 38 34 C26 28 14 8 0 0 Z',
  round: 'M0 0 C14 -22 38 -16 36 0 C38 16 14 22 0 0 Z',
};
const DORSAL: Record<FishLook['dorsal'], string> = {
  sail: 'M0 4 C10 -20 38 -20 48 4 Z',
  spike: 'M0 6 L7 -12 L15 2 L23 -16 L31 2 L39 -10 L46 6 Z',
  wave: 'M0 6 C8 -8 16 2 24 -10 C32 2 40 -6 48 6 Z',
  tuft: 'M10 6 C10 -12 30 -16 34 4 Z',
};

/** The body outline per shape, head on the left. Returns the path and where tail, fins and eye go. */
function bodyOf(l: FishLook): { d: string; tail?: [number, number, number]; dorsal?: [number, number, number]; eye: [number, number]; belly: string } {
  switch (l.shape) {
    case 'long':
      return { d: 'M12 52 C22 38 52 40 78 41 C106 42 124 45 136 50 C124 56 106 59 78 61 C52 63 22 66 12 52 Z', tail: [134, 50, 0.62], dorsal: [60, 42, 1.25], eye: [30, 49], belly: 'M20 56 C50 64 104 60 130 53 C106 59 52 63 20 56 Z' };
    case 'whale':
      return { d: 'M16 58 C14 32 44 22 76 26 C104 30 122 42 132 50 C122 60 102 74 74 76 C44 78 18 76 16 58 Z', tail: [130, 50, 0.85], dorsal: [80, 30, 0.6], eye: [40, 50], belly: 'M20 64 C40 76 92 76 120 60 C100 72 50 80 20 64 Z' };
    case 'star':
      return { d: starPath(80, 52, 44, 21, 5), eye: [80, 50], belly: '' };
    case 'ray':
      return { d: 'M14 54 C40 30 64 16 82 20 C100 16 124 30 148 54 C126 60 104 66 88 80 C84 88 78 88 74 80 C58 66 36 60 14 54 Z', eye: [64, 46], belly: '' };
    default:
      return { d: 'M28 52 C28 30 52 20 76 21 C102 22 118 38 118 52 C118 66 102 82 76 83 C52 84 28 74 28 52 Z', tail: [116, 52, 1], dorsal: [54, 24, 1], eye: [46, 47], belly: 'M34 62 C46 80 96 82 112 62 C100 76 52 84 34 62 Z' };
  }
}

function starPath(cx: number, cy: number, R: number, r: number, n: number): string {
  // Rounded star: control points between the tips.
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const rad = i % 2 ? r : R;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return roundedPoly(pts);
}

function roundedPoly(pts: string[]): string {
  // Quadratic curves through midpoints: soft tips.
  const p = pts.map((s) => s.split(' ').map(Number) as [number, number]);
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(p[p.length - 1], p[0]);
  let d = `M${start[0].toFixed(1)} ${start[1].toFixed(1)}`;
  for (let i = 0; i < p.length; i++) {
    const m = mid(p[i], p[(i + 1) % p.length]);
    d += ` Q${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`;
  }
  return d + ' Z';
}

function Pattern({ l, id }: { l: FishLook; id: string }) {
  const s = l.seeds;
  const m = l.mark;
  switch (l.pattern) {
    case 1: return <g fill={m} opacity=".8">{[0, 1, 2].map((i) => <rect key={i} x={50 + i * 20 + s[i] * 4} y="10" width={7 + s[i + 3] * 4} height="90" rx="4" />)}</g>;
    case 2: return <g fill={m} opacity=".75">{Array.from({ length: 9 }, (_, i) => <circle key={i} cx={40 + s[i] * 80} cy={30 + s[(i + 5) % 16] * 44} r={2.5 + s[(i + 9) % 16] * 4} />)}</g>;
    case 3: return <g fill="none" stroke={m} strokeWidth="1.6" opacity=".55">{Array.from({ length: 4 }, (_, row) => Array.from({ length: 7 }, (_, c) => <path key={`${row}-${c}`} d={`M${42 + c * 12 + (row % 2) * 6} ${34 + row * 11} a6 6 0 0 0 12 0`} />))}</g>;
    case 4: return <path d="M30 56 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10 l10 10 l10 -10" fill="none" stroke={m} strokeWidth="4" strokeLinejoin="round" opacity=".7" />;
    case 5: return <g opacity=".75"><path d="M20 50 C60 42 100 44 140 50" stroke={m} strokeWidth="6" fill="none" strokeLinecap="round" /><path d="M30 60 C70 56 100 57 130 58" stroke={m} strokeWidth="2.5" fill="none" strokeLinecap="round" /></g>;
    case 6: return <g fill="none" stroke={m} strokeWidth="2.4" opacity=".7">{Array.from({ length: 4 }, (_, i) => <circle key={i} cx={50 + s[i] * 60} cy={38 + s[i + 4] * 28} r={5 + s[i + 8] * 5} />)}</g>;
    case 7: return <rect x="60" y="0" width="100" height="100" fill={`url(#${id}-fade)`} />;
    case 8: {
      const pts = Array.from({ length: 6 }, (_, i) => [45 + i * 13 + s[i] * 6, 34 + s[i + 6] * 32]);
      return <g opacity=".85"><polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={m} strokeWidth="1" strokeDasharray="2 3" />{pts.map((p, i) => <path key={i} transform={`translate(${p[0]} ${p[1]}) scale(${0.5 + s[i + 10] * 0.5})`} d="M0 -5 L1.4 -1.4 L5 0 L1.4 1.4 L0 5 L-1.4 1.4 L-5 0 L-1.4 -1.4 Z" fill={m} />)}</g>;
    }
    case 9: return <g fill="none" stroke={m} strokeWidth="3" opacity=".5" strokeLinecap="round"><path d={`M30 ${40 + s[0] * 10} C55 ${20 + s[1] * 20} 75 ${60 + s[2] * 10} 105 ${36 + s[3] * 14}`} /><path d={`M40 ${62 + s[4] * 8} C65 ${48 + s[5] * 10} 90 ${74 + s[6] * 6} 120 ${56 + s[7] * 8}`} /></g>;
    default: return null;
  }
}

/** One species, drawn from its catalogue entry. `vertical` turns it nose-up (narrow exhibit cells). */
export function FishArt({ fish, vertical = false, className }: { fish?: Species; vertical?: boolean; className?: string }) {
  const uid = useId().replace(/:/g, '');
  if (!fish) return <svg viewBox="0 0 160 100" className={cx('h-full w-full', className)} aria-hidden><path d="M40 50 C40 34 70 28 90 36 L118 22 L112 50 L118 78 L90 64 C70 72 40 66 40 50 Z" fill="currentColor" opacity=".15" /></svg>;
  const l = fishLook(fish);
  const b = bodyOf(l);
  const id = `f${uid}`;
  const iridescent = l.rarity >= 4;
  const bodyFill = iridescent ? `url(#${id}-holo)` : `url(#${id}-body)`;
  return <svg viewBox="0 0 160 100" role="img" aria-label={fish.name} className={cx('h-full w-full overflow-visible', vertical && '-rotate-90 scale-90', className)}>
    <defs>
      <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={l.body} /><stop offset=".62" stopColor={l.body} /><stop offset="1" stopColor={l.belly} /></linearGradient>
      <linearGradient id={`${id}-holo`} x1="0" y1="0" x2="1" y2="1">
        {[0, 1, 2, 3, 4].map((i) => <stop key={i} offset={i / 4} stopColor={`hsl(${l.hue + i * 55} 85% ${68 - (i % 2) * 8}%)`} />)}
      </linearGradient>
      <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={l.accent} stopOpacity="0" /><stop offset="1" stopColor={l.accent} stopOpacity=".85" /></linearGradient>
      <radialGradient id={`${id}-glow`}><stop offset="0" stopColor={l.accent} stopOpacity=".55" /><stop offset="1" stopColor={l.accent} stopOpacity="0" /></radialGradient>
      <clipPath id={`${id}-clip`}><path d={b.d} /></clipPath>
    </defs>
    {l.rarity >= 3 && <ellipse cx="80" cy="52" rx="78" ry="48" fill={`url(#${id}-glow)`} className="fish-aura" />}
    <g stroke={l.line} strokeWidth="2.2" strokeLinejoin="round">
      {b.tail && <path d={TAIL[l.tail]} transform={`translate(${b.tail[0]} ${b.tail[1]}) scale(${b.tail[2]})`} fill={l.fin} />}
      {b.tail && l.rarity >= 1 && <path d={TAIL[l.tail]} transform={`translate(${b.tail[0]} ${b.tail[1]}) scale(${b.tail[2]})`} fill={`url(#${id}-fade)`} stroke="none" />}
      {b.dorsal && <path d={DORSAL[l.dorsal]} transform={`translate(${b.dorsal[0]} ${b.dorsal[1] - 4}) scale(${b.dorsal[2]})`} fill={l.fin} />}
      {l.shape === 'ray' && <path d="M80 84 C82 92 92 98 104 99" fill="none" strokeWidth="2.6" strokeLinecap="round" />}
      <path d={b.d} fill={bodyFill} />
    </g>
    <g clipPath={`url(#${id}-clip)`}>
      <Pattern l={l} id={id} />
      {b.belly && <path d={b.belly} fill={l.belly} opacity=".55" />}
      {/* top light */}
      <path d="M20 30 C60 10 110 14 150 32 L150 40 C110 26 60 24 20 42 Z" fill="#fff" opacity=".18" />
    </g>
    <path d={b.d} fill="none" stroke={l.line} strokeWidth="2.2" strokeLinejoin="round" />
    {/* side fin */}
    {l.shape !== 'star' && l.shape !== 'ray' && <path d={`M${b.eye[0] + 18} ${b.eye[1] + 10} c8 -2 16 4 18 12 c-8 2 -16 -2 -18 -12 Z`} fill={l.fin} stroke={l.line} strokeWidth="1.6" strokeLinejoin="round" />}
    {/* face */}
    <circle cx={b.eye[0]} cy={b.eye[1]} r={l.eye} fill="#fff" stroke={l.line} strokeWidth="1.6" />
    <circle cx={b.eye[0] - 1.2} cy={b.eye[1] + 0.6} r={l.eye * 0.58} fill="#132235" />
    <circle cx={b.eye[0] - 2.6} cy={b.eye[1] - 1.6} r={l.eye * 0.22} fill="#fff" />
    {l.shape === 'star' && <circle cx={b.eye[0] + 16} cy={b.eye[1]} r={l.eye} fill="#fff" stroke={l.line} strokeWidth="1.6" />}
    {l.shape === 'star' && <circle cx={b.eye[0] + 14.8} cy={b.eye[1] + 0.6} r={l.eye * 0.58} fill="#132235" />}
    <path d={l.shape === 'star' ? `M${b.eye[0] + 3} ${b.eye[1] + 12} q5 5 10 0` : `M${b.eye[0] - 12} ${b.eye[1] + 11} q5 4 9 -1`} fill="none" stroke={l.line} strokeWidth="2" strokeLinecap="round" />
    {l.cheeks && <ellipse cx={b.eye[0] + (l.shape === 'star' ? 8 : 4)} cy={b.eye[1] + 12} rx="5" ry="3" fill="#ff7a9a" opacity=".45" />}
    {/* rarity sparkle */}
    {l.rarity >= 2 && <g fill="#fffbe6" stroke={l.accent} strokeWidth="1" className="fish-sparkle">
      <path d="M128 12 L131 20 L139 23 L131 26 L128 34 L125 26 L117 23 L125 20 Z" />
      {l.rarity >= 3 && <path transform="translate(20 70) scale(.6)" d="M0 -10 L3 -3 L10 0 L3 3 L0 10 L-3 3 L-10 0 L-3 -3 Z" />}
      {l.rarity >= 4 && <path transform="translate(88 6) scale(.5)" d="M0 -10 L3 -3 L10 0 L3 3 L0 10 L-3 3 L-10 0 L-3 -3 Z" />}
    </g>}
  </svg>;
}

// ---------- cards & badges ----------

const TIER_NAME = CARD_RARITY;

/** A collectible card: metal frame by card tier, the fish in its water. */
export function FishCard({ card, rules, count }: { card: string; rules: FishingRules; count?: number }) {
  const [tier, id] = cardParts(card);
  const f = rules.catalog.find((s) => s.id === id);
  const water = RARITY_WATER[f?.rarity ?? 0];
  return <div className={`fish-card fish-metal-${tier}`} title={`${TIER_NAME[tier]}卡 · ${f?.name}`}>
    <div className="fish-card-inner" style={{ '--w1': water[0], '--w2': water[1] } as CSSProperties}>
      <div className="fish-card-top"><span className="fish-card-tier">{TIER_NAME[tier]}</span><span>No.{id.slice(1)}</span></div>
      <div className="fish-card-art"><FishArt fish={f} /></div>
      <div className="fish-card-name">{f?.name ?? id}</div>
      <div className="fish-card-stars" aria-label={`稀有度 ${(f?.rarity ?? 0) + 1}`}>{Array.from({ length: (f?.rarity ?? 0) + 1 }, (_, i) => <i key={i} />)}</div>
    </div>
    {count !== undefined && count > 1 && <span className="fish-card-count">×{count}</span>}
  </div>;
}

const MEDAL = [['#8b97a8', '#c9d1dc'], ['#a8683f', '#e3b28c'], ['#8fa6bd', '#e6eef6'], ['#d39b12', '#ffe28a'], ['#8b6cf6', '#f0c9ff']];

/** A collection badge: tier colour, level I–IV. */
export function FishingBadge({ tier, level }: { tier: number; level: number }) {
  const id = `b${useId().replace(/:/g, '')}`;
  const [c1, c2] = MEDAL[tier] ?? MEDAL[0];
  const roman = ['', 'I', 'II', 'III', 'IV'][level] ?? '';
  return <div className="flex h-full min-h-16 flex-col items-center justify-center gap-0.5" title={`${TIER_NAME[tier]}·${roman} 级收藏徽章`}>
    <svg viewBox="0 0 80 92" className="h-16 w-16" aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={c2} /><stop offset=".55" stopColor={c1} /><stop offset="1" stopColor={c2} /></linearGradient></defs>
      <path d="M24 50 L14 88 L28 80 L36 90 L40 56 Z" fill="#3c6fb4" /><path d="M56 50 L66 88 L52 80 L44 90 L40 56 Z" fill="#e2557a" />
      <circle cx="40" cy="36" r="31" fill={`url(#${id})`} stroke="#fff" strokeWidth="3" />
      <circle cx="40" cy="36" r="24" fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="M40 15 C47 22 56 26 56 34 C56 44 47 50 40 56 C33 50 24 44 24 34 C24 26 33 22 40 15 Z" fill="#fff" fillOpacity=".88" />
      <path d="M33 36 c4 -6 10 -6 14 0 l6 -4 -1 8 1 8 -6 -4 c-4 6 -10 6 -14 0 Z" fill={c1} />
      <text x="40" y="74" textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700" stroke={c1} strokeWidth="3" paintOrder="stroke">{roman}</text>
    </svg>
    <span className="text-[10px] font-medium">{TIER_NAME[tier]} · {level} 级</span>
  </div>;
}

// ---------- tool icons ----------

/** Little pictures of the shop's tools. */
export function ToolIcon({ kind, size = 28 }: { kind?: string; size?: number }) {
  const rod = (color: string, extra?: ReactNode) => <>
    <path d="M6 30 C14 22 22 12 30 4" stroke={color} strokeWidth="3" strokeLinecap="round" fill="none" />
    <path d="M30 4 C31 12 30 18 26 22" stroke="currentColor" strokeOpacity=".5" strokeWidth="1" fill="none" />
    <circle cx="11" cy="25" r="3.2" fill={color} stroke="#fff" strokeWidth="1" />
    {extra}
  </>;
  const glove = (extra?: ReactNode) => <>
    <path d="M10 30 L9 16 C9 13 13 13 13 16 L13 10 C13 7 17 7 17 10 L17 9 C17 6 21 6 21 9 L21 11 C21 8 25 8 25 11 L25 22 C25 27 22 30 18 30 Z" fill="#f2b98d" stroke="#8a5434" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M10 26 H25" stroke="#8a5434" strokeWidth="1.4" />
    {extra}
  </>;
  const body: Record<string, ReactNode> = {
    speed: rod('#2c9b8f', <g stroke="#6cc5ff" strokeWidth="2" strokeLinecap="round"><path d="M18 26 h8" /><path d="M21 31 h8" /><path d="M24 21 h6" /></g>),
    auto: rod('#7a5cd6', <g><path d="M18 24 c3 -3 7 -3 9 0 l3 -2 -1 2.5 1 2.5 -3 -2 c-2 3 -6 3 -9 0 Z" fill="#fb923c" /><path d="M14 31 c3 -3 7 -3 9 0 l3 -2 -1 2.5 1 2.5 -3 -2 c-2 3 -6 3 -9 0 Z" fill="#38bdf8" /></g>),
    value: rod('#d39b12', <g><circle cx="25" cy="26" r="5" fill="#ffd34d" stroke="#a87410" strokeWidth="1.4" /><path d="M25 23.5 v5" stroke="#a87410" strokeWidth="1.4" /></g>),
    glove: glove(<g fill="#fb923c" stroke="#9a4d14" strokeWidth=".8"><path d="M27 6 c2 -2 5 -2 6 0 l2 -1 -.6 1.5 .6 1.5 -2 -1 c-1 2 -4 2 -6 0 Z" /><path d="M27 13 c2 -2 5 -2 6 0 l2 -1 -.6 1.5 .6 1.5 -2 -1 c-1 2 -4 2 -6 0 Z" /></g>),
    glove_haste: glove(<g stroke="#6cc5ff" strokeWidth="2" strokeLinecap="round"><path d="M1 14 h6" /><path d="M2 20 h5" /><path d="M3 9 h4" /></g>),
    glove_value: glove(<g><circle cx="29" cy="9" r="5" fill="#ffd34d" stroke="#a87410" strokeWidth="1.3" /><path d="M29 6.5 v5" stroke="#a87410" strokeWidth="1.3" /></g>),
    ward: <>
      <path d="M18 3 L30 8 V17 C30 25 24 30 18 33 C12 30 6 25 6 17 V8 Z" fill="#5fb7c9" stroke="#25657a" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 19 c3 -3 5 -3 8 0 c3 3 5 3 8 0" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />
      <path d="M12 13 c2 -2 4 -2 6 0 c2 2 4 2 6 0" stroke="#fff" strokeOpacity=".7" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>,
  };
  return <svg viewBox="0 0 36 36" width={size} height={size} aria-hidden className="shrink-0">{kind && body[kind] ? body[kind] : <rect x="8" y="8" width="20" height="20" rx="6" fill="none" stroke="currentColor" strokeOpacity=".35" strokeDasharray="3 3" strokeWidth="1.6" />}</svg>;
}

/** The game's emblem: a crescent moon over the water with a hook. */
export function PondEmblem({ size = 44 }: { size?: number }) {
  const id = `e${useId().replace(/:/g, '')}`;
  return <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2d3d7a" /><stop offset="1" stopColor="#167c74" /></linearGradient></defs>
    <rect width="48" height="48" rx="14" fill={`url(#${id})`} />
    <path d="M30 9 a10 10 0 1 0 7 15 a8 8 0 1 1 -7 -15 Z" fill="#ffe29a" />
    <path d="M8 34 c5 -3 9 -3 14 0 c5 3 9 3 14 0" stroke="#bfe9ff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    <path d="M16 10 v12 a4 4 0 0 0 8 0" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" />
    <circle cx="11" cy="16" r="1.2" fill="#fff" /><circle cx="38" cy="38" r="1" fill="#fff" />
  </svg>;
}

// ---------- the pond ----------

/**
 * Where seat i (0–11) sits, in % of the square scene: three per side,
 * clockwise from the top left, and where its float lands in the water.
 */
export function seatSpot(i: number): { seat: [number, number]; float: [number, number] } {
  const side = Math.floor(i / 3), pos = 28 + (i % 3) * 22;
  const jitter = ((i * 37) % 9) - 4;
  switch (side) {
    case 0: return { seat: [pos, 9], float: [pos + jitter, 30 + ((i * 7) % 6)] };
    case 1: return { seat: [91, pos], float: [70 - ((i * 7) % 6), pos + jitter] };
    case 2: return { seat: [100 - pos, 91], float: [100 - pos + jitter, 70 - ((i * 7) % 6)] };
    default: return { seat: [9, 100 - pos], float: [30 + ((i * 7) % 6), 100 - pos + jitter] };
  }
}

/** The pond under the seat buttons: island boardwalk, night water, stars, fish shadows, lines and floats. */
export function PondScene({ lines }: { lines: { i: number; mine: boolean; bite: boolean }[] }) {
  const id = `p${useId().replace(/:/g, '')}`;
  const stars = Array.from({ length: 26 }, (_, k) => [(k * 61) % 100, (k * 37 + 11) % 100, 0.5 + ((k * 13) % 10) / 10]);
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="fish-scene-art" aria-hidden>
    <defs>
      <linearGradient id={`${id}-ground`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--pond-grass-1)" /><stop offset="1" stopColor="var(--pond-grass-2)" /></linearGradient>
      <radialGradient id={`${id}-water`} cx=".35" cy=".25" r="1"><stop offset="0" stopColor="var(--pond-water-1)" /><stop offset=".55" stopColor="var(--pond-water-2)" /><stop offset="1" stopColor="var(--pond-water-3)" /></radialGradient>
      <pattern id={`${id}-planks`} width="12" height="4.4" patternUnits="userSpaceOnUse">
        <rect width="12" height="4.4" fill="var(--pond-wood-1)" />
        <path d="M0 2.2 H12 M0 4.4 H12" stroke="var(--pond-wood-2)" strokeWidth=".3" />
        <path d="M3 0 V2.2 M9 2.2 V4.4" stroke="var(--pond-wood-2)" strokeWidth=".22" />
        <path d="M1 1.1 H2.4 M6 3.3 H7.6" stroke="var(--pond-wood-2)" strokeOpacity=".35" strokeWidth=".18" strokeLinecap="round" />
      </pattern>
      <radialGradient id={`${id}-lamp`}><stop offset="0" stopColor="#ffd98a" stopOpacity=".9" /><stop offset="1" stopColor="#ffd98a" stopOpacity="0" /></radialGradient>
      <clipPath id={`${id}-wclip`}><rect x="19" y="19" width="62" height="62" rx="9" /></clipPath>
    </defs>
    {/* island and boardwalk ring */}
    <rect x="0" y="0" width="100" height="100" rx="8" fill={`url(#${id}-ground)`} />
    <g opacity=".5" fill="var(--pond-grass-3)">{[[4, 4], [96, 6], [5, 95], [94, 94], [50, 2.5], [2.5, 50]].map(([x, y], k) => <circle key={k} cx={x} cy={y} r="2.2" />)}</g>
    <rect x="2.5" y="2.5" width="95" height="95" rx="9" fill={`url(#${id}-planks)`} stroke="var(--pond-wood-2)" strokeWidth=".6" />
    <rect x="3.6" y="3.6" width="92.8" height="92.8" rx="8" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth=".4" />
    {/* lanterns on the corners */}
    {[[9, 9], [91, 9], [9, 91], [91, 91]].map(([x, y], k) => <g key={k}><circle cx={x} cy={y} r="7" fill={`url(#${id}-lamp)`} className="fish-lamp" style={{ animationDelay: `${k * 0.7}s` }} /><rect x={x - 1.4} y={y - 1.8} width="2.8" height="3.6" rx=".8" fill="#ffcf6a" stroke="#8a5a1c" strokeWidth=".35" /></g>)}
    {/* water */}
    <rect x="19" y="19" width="62" height="62" rx="9" fill={`url(#${id}-water)`} stroke="var(--pond-rim)" strokeWidth="1.2" />
    <g clipPath={`url(#${id}-wclip)`}>
      {stars.map(([x, y, r], k) => <circle key={k} cx={19 + x * 0.62} cy={19 + y * 0.62} r={r * 0.32} fill="#e8f6ff" className="fish-star" style={{ animationDelay: `${(k % 7) * 0.6}s` }} />)}
      <g className="fish-moon" fill="#fff1b8">
        <circle cx="64" cy="31" r="3.4" opacity=".85" />
        <circle cx="65.6" cy="30" r="3" fill="var(--pond-water-2)" opacity=".9" />
        <rect x="60" y="36" width="7" height=".5" rx=".25" opacity=".45" />
        <rect x="61.5" y="38" width="4.5" height=".45" rx=".22" opacity=".35" />
        <rect x="62.5" y="39.8" width="2.6" height=".4" rx=".2" opacity=".25" />
      </g>
      {/* drifting fish shadows */}
      {[0, 1, 2].map((k) => <g key={k} className={`fish-shadow fish-shadow-${k}`}><path d="M0 0 c3 -2.4 7 -2.4 9 0 l3 -2 -1 2 1 2 -3 -2 c-2 2.4 -6 2.4 -9 0 Z" fill="#06202d" opacity=".32" /></g>)}
      {/* lily pads */}
      <g fill="var(--pond-lily)" stroke="var(--pond-lily-line)" strokeWidth=".3"><path d="M25 74 a4 3 0 1 0 6 -2 l-3 1.5 Z" /><path d="M74 25 a3 2.4 0 1 0 4.6 -1.6 l-2.3 1.2 Z" /><circle cx="28.5" cy="71" r=".9" fill="#ffc2d6" stroke="none" /></g>
    </g>
    {/* lines and floats */}
    {lines.map(({ i, mine, bite }) => {
      const { seat, float } = seatSpot(i);
      const sx = seat[0] + (float[0] - seat[0]) * 0.18, sy = seat[1] + (float[1] - seat[1]) * 0.18;
      return <g key={i} className={cx('fish-float', mine && 'is-mine', bite && 'is-bite')}>
        <path d={`M${sx} ${sy} Q${(sx + float[0]) / 2} ${(sy + float[1]) / 2 + 3} ${float[0]} ${float[1]}`} stroke="#eaf8ff" strokeOpacity=".45" strokeWidth=".25" fill="none" />
        {bite && <><circle cx={float[0]} cy={float[1]} r="2" className="fish-ripple" /><circle cx={float[0]} cy={float[1]} r="2" className="fish-ripple fish-ripple-2" /></>}
        <g className="fish-bob" style={{ transformOrigin: `${float[0]}px ${float[1]}px` }}>
          <ellipse cx={float[0]} cy={float[1] + 0.6} rx="1.3" ry=".45" fill="#fff" opacity=".35" />
          <path d={`M${float[0] - 0.9} ${float[1]} a.9 .9 0 0 1 1.8 0 Z`} fill={mine ? '#ffd166' : '#ff6b6b'} />
          <path d={`M${float[0] - 0.9} ${float[1]} a.9 .9 0 0 0 1.8 0 Z`} fill="#fff" />
          <path d={`M${float[0]} ${float[1] - 0.9} v-1.6`} stroke={mine ? '#ffd166' : '#ff6b6b'} strokeWidth=".35" />
        </g>
      </g>;
    })}
  </svg>;
}
