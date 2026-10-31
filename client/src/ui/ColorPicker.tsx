// Our own colour picker (replaces the system one, which looked out of
// place): a saturation / brightness square, a hue bar, hex input, screen
// eyedropper where the webview has one, preset and recent colours. Colour
// math is lib/color.ts.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Pipette } from 'lucide-react';
import { hexToHsv, hsvToHex, hueHex, normalizeHex, onColor, pushRecent, type HSV } from '@/lib/color';
import { cx, spring } from './index';

const RECENT_KEY = 'am-recent-colors';

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(hex: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), hex)));
  } catch {
    /* private mode: no recent list */
  }
}

/** Drags inside an element; reports the pointer position as 0–1 fractions. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onMove(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
    },
  };
}

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> };

export function ColorPicker({ value, onChange, presets = [] }: { value: string; onChange: (hex: string) => void; presets?: string[] }) {
  // Keep hue / saturation while the colour is grey or black (hex alone loses them).
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(normalizeHex(value) ?? '#ee5b9a'));
  const [text, setText] = useState(value);
  const [recent] = useState(readRecent);
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      const n = normalizeHex(value);
      if (n) setHsv(hexToHsv(n));
      setText(value);
    }
  }, [value]);
  const set = (next: HSV) => {
    setHsv(next);
    const hex = hsvToHex(next);
    last.current = hex;
    setText(hex);
    onChange(hex);
  };
  const setHex = (hex: string) => {
    const n = normalizeHex(hex);
    if (n) set(hexToHsv(n));
  };
  const sv = useDrag((x, y) => set({ ...hsv, s: x, v: 1 - y }));
  const hue = useDrag((x) => set({ ...hsv, h: x * 360 }));
  const current = hsvToHex(hsv);
  const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  const key = (dx: number, dy: number) => set({ ...hsv, s: Math.min(1, Math.max(0, hsv.s + dx)), v: Math.min(1, Math.max(0, hsv.v + dy)) });

  const swatch = (c: string) => (
    <button
      key={c}
      type="button"
      onClick={() => setHex(c)}
      aria-label={c}
      title={c}
      className="press flex h-6 w-6 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]"
      style={{ background: c }}
    >
      {c === current && <Check size={12} style={{ color: onColor(c) }} />}
    </button>
  );

  return (
    <div className="w-[264px] space-y-3">
      <div
        {...sv}
        role="slider"
        tabIndex={0}
        aria-label="饱和度和亮度"
        aria-valuetext={current}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
          if (d[e.key]) {
            e.preventDefault();
            key(...d[e.key]);
          }
        }}
        className="relative h-40 cursor-crosshair touch-none overflow-hidden rounded-2xl"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueHex(hsv.h)}` }}
      >
        <span
          className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_2px_6px_rgb(0_0_0/0.3)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: current }}
        />
      </div>
      <div className="flex items-center gap-3">
        {EyeDropper && (
          <button
            type="button"
            aria-label="从屏幕取色"
            title="从屏幕取色"
            onClick={() => new EyeDropper().open().then((r) => setHex(r.sRGBHex)).catch(() => {})}
            className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-ink-soft hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            <Pipette size={16} />
          </button>
        )}
        <div
          {...hue}
          role="slider"
          tabIndex={0}
          aria-label="色相"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
            if (d) {
              e.preventDefault();
              set({ ...hsv, h: (hsv.h + d + 360) % 360 });
            }
          }}
          className="relative h-3 flex-1 cursor-pointer touch-none rounded-full"
          style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        >
          <span
            className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_1px_4px_rgb(0_0_0/0.35)]"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: hueHex(hsv.h) }}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-9 w-9 shrink-0 rounded-xl shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]" style={{ background: current }} />
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setHex(e.target.value);
          }}
          onBlur={() => setText(current)}
          aria-label="颜色代码"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-xl border border-black/10 bg-white/70 px-3 font-mono text-[0.9rem] uppercase outline-none focus:border-accent dark:border-white/10 dark:bg-white/5"
        />
      </div>
      {presets.length > 0 && <div className="flex flex-wrap gap-1.5">{presets.map(swatch)}</div>}
      {recent.length > 0 && (
        <div>
          <div className="mb-1 text-[0.75rem] text-ink-soft dark:text-white/45">最近用过</div>
          <div className="flex flex-wrap gap-1.5">{recent.map(swatch)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * A button that opens the picker in a floating glass panel next to it.
 * The colour applies live; the panel closes on a click outside or Esc.
 */
export function ColorButton({ value, onChange, presets, label, children, className, style }: {
  value: string; onChange: (hex: string) => void; presets?: string[]; label: string;
  children?: ReactNode; className?: string; style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 296;
    const h = panel.current?.offsetHeight ?? 380;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left));
    const below = r.bottom + 8;
    setPos({ left, top: below + h > window.innerHeight - 12 ? Math.max(12, r.top - h - 8) : below });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !btn.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', esc, true);
      saveRecent(value);
    };
  }, [open, value]);
  return (
    <>
      <button ref={btn} type="button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)} className={className} style={style}>
        {children}
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panel}
              role="dialog"
              aria-label={label}
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={spring}
              className={cx('glass-strong fixed z-[60] rounded-3xl p-4 shadow-[var(--shadow-lift)]')}
              style={{ left: pos.left, top: pos.top, transformOrigin: 'top left' }}
            >
              <ColorPicker value={value} onChange={onChange} presets={presets} />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
