// AI portrait in an AI chat. It floats on the chat's own background in the
// upper part of the window, never over the messages: the band it sits in
// pushes the message list down. Position (left / center / right) or folded
// into a small avatar in the top-right corner is a per-device preference;
// moving and folding morph smoothly with springs.
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, Minimize2 } from 'lucide-react';
import { DEFAULT_PACK } from '@/lib/defaultPack';
import { resolveMood, type Mood, type Pack } from '@/lib/portraits';
import { usePrefs, type PortraitPos } from '@/lib/prefs';
import type { User } from '@/lib/types';
import { cx } from '@/ui';

/** Slower, softer spring than the UI default: big things should glide. */
const glide: Transition = { type: 'spring', stiffness: 230, damping: 30, mass: 1 };
const fade: Transition = { duration: 0.45, ease: [0.22, 1, 0.36, 1] };

function moodOf(user: User, mood?: Mood): Mood {
  return user.online === false ? 'offline' : mood ?? 'neutral';
}

/** The band under the chat header. Collapses to nothing when folded. */
export function PortraitBand({ user, mood, pack = DEFAULT_PACK }: { user: User; mood?: Mood; pack?: Pack }) {
  const pos = usePrefs((s) => s.portrait);
  const img = resolveMood(pack, moodOf(user, mood));
  const open = pos !== 'corner' && !!img;
  return (
    <motion.div
      className="group/portrait relative shrink-0 overflow-hidden"
      initial={false}
      animate={{ height: open ? '46%' : 0 }}
      transition={glide}
    >
      <div className={cx('flex h-full px-8 pt-3', pos === 'left' ? 'justify-start' : pos === 'right' ? 'justify-end' : 'justify-center')}>
        {open && img && (
          <motion.div layoutId={`portrait-${user.id}`} layout transition={glide} className="relative aspect-square h-full">
            <motion.div
              className="absolute inset-0"
              animate={img.grey ? { y: 0 } : { y: [0, -7, 0] }}
              transition={img.grey ? fade : { duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}
            >
              <AnimatePresence initial={false}>
                <motion.img
                  key={img.src}
                  src={img.src}
                  alt={user.name}
                  draggable={false}
                  className={cx(
                    'absolute inset-0 h-full w-full object-contain object-bottom drop-shadow-[0_16px_28px_rgb(30_25_50/0.16)] transition-[filter,opacity] duration-700',
                    img.grey && 'opacity-70 grayscale',
                  )}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  transition={fade}
                />
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </div>
      {open && <PositionControls pos={pos} />}
    </motion.div>
  );
}

function PositionControls({ pos }: { pos: PortraitPos }) {
  const set = usePrefs((s) => s.setPortrait);
  const items: { p: PortraitPos; label: string; Icon: typeof Minimize2 }[] = [
    { p: 'left', label: '立绘靠左', Icon: AlignHorizontalJustifyStart },
    { p: 'center', label: '立绘居中', Icon: AlignHorizontalJustifyCenter },
    { p: 'right', label: '立绘靠右', Icon: AlignHorizontalJustifyEnd },
    { p: 'corner', label: '收起到右上角', Icon: Minimize2 },
  ];
  return (
    <div className="absolute top-3 right-4 flex gap-0.5 rounded-xl bg-white/80 p-1 opacity-0 shadow-[var(--shadow-card)] backdrop-blur transition-opacity duration-300 group-hover/portrait:opacity-100 focus-within:opacity-100 dark:bg-white/10">
      {items.map(({ p, label, Icon }) => (
        <button
          key={p}
          onClick={() => set(p)}
          aria-label={label}
          title={label}
          aria-pressed={pos === p}
          className={cx(
            'press flex h-7 w-7 items-center justify-center rounded-lg',
            pos === p ? 'bg-accent text-white' : 'text-ink-soft hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10',
          )}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

/** Folded portrait: a small round face in the header; click to unfold. */
export function PortraitCorner({ user, mood, pack = DEFAULT_PACK }: { user: User; mood?: Mood; pack?: Pack }) {
  const pos = usePrefs((s) => s.portrait);
  const reopen = usePrefs((s) => s.portraitOpen);
  const set = usePrefs((s) => s.setPortrait);
  const img = resolveMood(pack, moodOf(user, mood));
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
