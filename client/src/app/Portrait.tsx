// AI portrait in an AI chat. It hangs over the top of the normal chat:
// messages scroll up behind it and stay visible around the figure, and it
// never takes clicks. Position (left / center / right) or folded into a
// small avatar in the header is a per-device preference; moving and folding
// morph smoothly with springs.
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, Minimize2 } from 'lucide-react';
import { DEFAULT_PACK } from '@/lib/defaultPack';
import { resolveMood, type Mood, type Pack } from '@/lib/portraits';
import { usePrefs, type PortraitPos } from '@/lib/prefs';
import type { User } from '@/lib/types';
import { IconButton, cx, openMenu } from '@/ui';

/** Slower, softer spring than the UI default: big things should glide. */
const glide: Transition = { type: 'spring', stiffness: 230, damping: 30, mass: 1 };
const fade: Transition = { duration: 0.45, ease: [0.22, 1, 0.36, 1] };

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
export function PortraitOverlay({ user, online, mood, pack = DEFAULT_PACK }: { user: User; online: boolean; mood?: Mood; pack?: Pack }) {
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
              <AnimatePresence initial={false}>
                <motion.img
                  key={img.src}
                  src={img.src}
                  alt=""
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
