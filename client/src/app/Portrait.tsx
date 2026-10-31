// AI portrait in an AI chat. It hangs over the top of the normal chat:
// messages scroll up behind it and stay visible around the figure. It takes
// no clicks itself: the chat asks `hitPortrait` whether a click landed on the
// figure (not on a transparent pixel) and turns that into a poke. Position (left / center / right) or folded into a
// small avatar in the header is a per-device preference; moving and folding
// morph smoothly with springs.
import { useEffect, useState } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, Minimize2 } from 'lucide-react';
import { DEFAULT_PACK } from '@/lib/defaultPack';
import { containedRect, ownPack, pokePart, resolveMood, type Mood, type Pack, type PokePart } from '@/lib/portraits';
import { session } from '@/lib/store';
import { usePrefs, type PortraitPos } from '@/lib/prefs';
import type { User } from '@/lib/types';
import { IconButton, cx, openMenu } from '@/ui';
import { mediaPath } from './media';

/** Slower, softer spring than the UI default: big things should glide. */
const glide: Transition = { type: 'spring', stiffness: 230, damping: 30, mass: 1 };
const fade: Transition = { duration: 0.45, ease: [0.22, 1, 0.36, 1] };

/** Alpha of each portrait picture, read once (custom packs from another origin can't be read: box test). */
const alphaCache = new Map<string, { w: number; h: number; data: Uint8ClampedArray } | null>();

function alphaOf(img: HTMLImageElement) {
  const src = img.currentSrc || img.src;
  if (alphaCache.has(src)) return alphaCache.get(src)!;
  let v: { w: number; h: number; data: Uint8ClampedArray } | null = null;
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w && h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      v = { w, h, data: g.getImageData(0, 0, w, h).data };
    }
  } catch {
    v = null;
  }
  if (img.complete) alphaCache.set(src, v);
  return v;
}

/** The part of the portrait under a screen point, or null for empty space around the figure. */
export function hitPortrait(container: HTMLElement | null, x: number, y: number): PokePart | null {
  // While pictures cross-fade the newest one is last.
  const img = [...(container?.querySelectorAll<HTMLImageElement>('img[data-portrait]') ?? [])].at(-1);
  if (!img || !img.naturalWidth) return null;
  const box = img.getBoundingClientRect();
  const r = containedRect(box.width, box.height, img.naturalWidth, img.naturalHeight);
  const fx = (x - box.left - r.x) / r.w;
  const fy = (y - box.top - r.y) / r.h;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const a = alphaOf(img);
  if (a) {
    const px = Math.min(a.w - 1, Math.floor(fx * a.w));
    const py = Math.min(a.h - 1, Math.floor(fy * a.h));
    if (a.data[(py * a.w + px) * 4 + 3] < 40) return null;
  } else if (fx < 0.2 || fx > 0.8) {
    return null;
  }
  return pokePart(fy);
}

/**
 * An AI's own portrait pack (docs/design.md §9 形象包), visible to everyone.
 * Loaded once per server + AI + version (`User.portraits_at`) and again after
 * 10 minutes, since other people's user records only refresh now and then.
 */
const packs = new Map<string, { at: number; p: Promise<Pack | null> }>();
const PACK_TTL = 10 * 60_000;

async function loadPack(serverId: string, userId: string): Promise<Pack | null> {
  const s = session(serverId);
  if (!s) return null;
  const ids = await s.portraits(userId);
  const urls = await Promise.all(Object.entries(ids).map(async ([mood, id]) => [mood, await s.t.mediaUrl(mediaPath(id))] as const));
  return ownPack(Object.fromEntries(urls));
}

/** Drops a cached pack (after its owner changed it on this device). */
export function forgetPack(serverId: string, userId: string) {
  for (const k of [...packs.keys()]) if (k.startsWith(`${serverId}|${userId}|`)) packs.delete(k);
}

export function usePortraitPack(serverId: string, user?: User): Pack {
  const userId = user?.id;
  const key = userId ? `${serverId}|${userId}|${user?.portraitsAt ?? 0}` : '';
  const [state, setState] = useState<{ key: string; pack: Pack | null }>({ key: '', pack: null });
  useEffect(() => {
    if (!key || !userId) return;
    let hit = packs.get(key);
    if (!hit || Date.now() - hit.at > PACK_TTL) {
      hit = { at: Date.now(), p: loadPack(serverId, userId).catch(() => null) };
      packs.set(key, hit);
    }
    let live = true;
    void hit.p.then((pack) => live && setState({ key, pack }));
    return () => {
      live = false;
    };
  }, [key, serverId, userId]);
  return (state.key === key && state.pack) || DEFAULT_PACK;
}

/** `online` is the AI account's presence: an AI that is not connected cannot reply. */
function moodOf(online: boolean, mood?: Mood): Mood {
  return online ? mood ?? 'neutral' : 'offline';
}

/**
 * The portrait hanging over the top of the message area. Messages scroll up
 * behind it (visible around the figure); it takes no clicks, so everything
 * under it still works. A soft glow around the outline blends it into the
 * chat (`.portrait-glow` in styles.css).
 */
export function PortraitOverlay({ user, online, mood, pack = DEFAULT_PACK, poked = 0 }: { user: User; online: boolean; mood?: Mood; pack?: Pack; poked?: number }) {
  const pos = usePrefs((s) => s.portrait);
  const img = resolveMood(pack, moodOf(online, mood));
  const open = pos !== 'corner' && !!img;
  return (
    <div
      aria-hidden
      className={cx(
        'pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[42%] px-8 pt-2',
        pos === 'left' ? 'justify-start' : pos === 'right' ? 'justify-end' : 'justify-center',
      )}
    >
      <AnimatePresence initial={false}>
        {open && img && (
          <motion.div
            layoutId={`portrait-${user.id}`}
            layout
            transition={glide}
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            className="relative aspect-square h-full"
          >
            <motion.div
              className="absolute inset-0"
              animate={img.grey ? { y: 0 } : { y: [0, -7, 0] }}
              transition={img.grey ? fade : { duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
            >
            {/* A poke: a quick squash and wobble, springy. */}
            <motion.div
              key={poked}
              className="absolute inset-0"
              initial={poked ? { scaleY: 0.94, scaleX: 1.04, rotate: -2 } : false}
              animate={{ scaleY: 1, scaleX: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 9 }}
              style={{ transformOrigin: '50% 100%' }}
            >
              <AnimatePresence initial={false}>
                <motion.img
                  key={img.src}
                  src={img.src}
                  alt=""
                  data-portrait
                  draggable={false}
                  className={cx('portrait-glow absolute inset-0 h-full w-full object-contain object-top', img.grey && 'grey')}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: img.grey ? 0.75 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  transition={fade}
                />
              </AnimatePresence>
            </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Header button: where the portrait sits (left / center / right / folded). */
export function PortraitPosButton() {
  const pos = usePrefs((s) => s.portrait);
  const set = usePrefs((s) => s.setPortrait);
  const items: { p: PortraitPos; label: string; Icon: typeof Minimize2 }[] = [
    { p: 'left', label: '立绘靠左', Icon: AlignHorizontalJustifyStart },
    { p: 'center', label: '立绘居中', Icon: AlignHorizontalJustifyCenter },
    { p: 'right', label: '立绘靠右', Icon: AlignHorizontalJustifyEnd },
    { p: 'corner', label: '收起到右上角', Icon: Minimize2 },
  ];
  const Current = items.find((i) => i.p === pos)?.Icon ?? AlignHorizontalJustifyCenter;
  return (
    <IconButton
      label="立绘位置"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: r.left, clientY: r.bottom + 6 }, items.map(({ p, label, Icon }) => ({
          label: pos === p ? `${label}（当前）` : label, icon: <Icon size={16} />, onClick: () => set(p),
        })));
      }}
    >
      <Current size={18} />
    </IconButton>
  );
}

/** Folded portrait: a small round face in the header; click to unfold. */
export function PortraitCorner({ user, online, mood, pack = DEFAULT_PACK }: { user: User; online: boolean; mood?: Mood; pack?: Pack }) {
  const pos = usePrefs((s) => s.portrait);
  const reopen = usePrefs((s) => s.portraitOpen);
  const set = usePrefs((s) => s.setPortrait);
  const img = resolveMood(pack, moodOf(online, mood));
  return (
    <AnimatePresence initial={false}>
      {pos === 'corner' && img && (
        <motion.button
          layoutId={`portrait-${user.id}`}
          transition={glide}
          onClick={() => set(reopen)}
          aria-label="展开立绘"
          title="展开立绘"
          className="press relative h-10 w-10 shrink-0 overflow-hidden rounded-full bg-accent-100 ring-2 ring-white shadow-[var(--shadow-card)] dark:bg-white/10 dark:ring-white/10"
        >
          <img
            src={img.src}
            alt=""
            draggable={false}
            className={cx('h-full w-full object-cover', img.grey && 'grayscale')}
            style={{ transform: 'scale(2)', transformOrigin: '50% 20%' }}
          />
        </motion.button>
      )}
    </AnimatePresence>
  );
}
