// Side columns that fold into a narrow strip of avatars (conversation list
// on the left, channel members on the right). The width glides with a
// spring and the two layouts cross-fade; each layout keeps its own fixed
// width so nothing reflows while the column moves. Folded or not is a
// per-device preference (lib/prefs.ts).
import type { ReactNode } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { cx } from '@/ui';

const glide: Transition = { type: 'spring', stiffness: 300, damping: 32, mass: 0.9 };
const fade: Transition = { duration: 0.22, ease: [0.22, 1, 0.36, 1] };

export function FoldColumn({ folded, width, foldedWidth, full, strip, label }: {
  folded: boolean;
  width: number;
  foldedWidth: number;
  full: ReactNode;
  strip: ReactNode;
  label: string;
}) {
  const w = folded ? foldedWidth : width;
  return (
    <motion.aside
      aria-label={label}
      initial={false}
      animate={{ width: w }}
      transition={glide}
      className="glass relative flex shrink-0 overflow-hidden rounded-3xl"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={folded ? 'strip' : 'full'}
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
          transition={fade}
          className="flex h-full shrink-0 flex-col"
          style={{ width: w }}
        >
          {folded ? strip : full}
        </motion.div>
      </AnimatePresence>
    </motion.aside>
  );
}

/** One avatar in a folded strip: tooltip with the name, highlight when active, optional badge. */
export function StripItem({ label, active, badge, dim, onClick, onContextMenu, children }: {
  label: string;
  active?: boolean;
  badge?: number;
  dim?: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={label}
      title={label}
      aria-current={active || undefined}
      className={cx(
        'lift relative mx-auto flex shrink-0 items-center justify-center rounded-2xl p-1.5',
        active ? 'bg-accent-100/90 shadow-[var(--shadow-card)] dark:bg-white/10' : 'hover:bg-white/70 dark:hover:bg-white/5',
        dim && 'opacity-60',
      )}
    >
      {children}
      {!!badge && (
        <span className="absolute right-0 bottom-0 min-w-[18px] rounded-full bg-accent px-1 text-center text-[0.68rem] leading-[18px] font-semibold text-white ring-2 ring-white dark:ring-[#1e1b36]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
