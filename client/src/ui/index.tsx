// Small UI kit on top of Tailwind and the theme tokens in styles.css
// (accent colour, glass, card / lift / press motion).
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { create } from 'zustand';
import { X } from 'lucide-react';
import type { User } from '@/lib/types';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/** Shared motion presets: ease-out for fades, a soft spring for movement. */
export const ease: Transition = { duration: 0.32, ease: [0.22, 1, 0.36, 1] };
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 34, mass: 0.8 };

// ---------- avatar ----------

const GRADIENTS = [
  ['#ff9ec7', '#ee5b9a'],
  ['#b9a6ff', '#7c5cf0'],
  ['#8fd0ff', '#3a8ddf'],
  ['#8ff0cf', '#1fae93'],
  ['#ffc58f', '#f28b30'],
  ['#ffb0b0', '#e5536b'],
  ['#a8b8ff', '#2f4fa8'],
];
function hash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

export function Avatar({ src, name, size = 40, status, square, className }: {
  src?: string; name: string; size?: number; status?: boolean; square?: boolean; className?: string;
}) {
  const [a, b] = GRADIENTS[hash(name || '?') % GRADIENTS.length];
  const radius = square ? Math.round(size * 0.3) : size / 2;
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className={cx('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {src && !broken ? (
        <img src={src} alt="" onError={() => setBroken(true)} className="h-full w-full object-cover" style={{ borderRadius: radius }} draggable={false} />
      ) : (
        <span
          className="flex h-full w-full items-center justify-center font-semibold text-white"
          style={{ borderRadius: radius, background: `linear-gradient(135deg, ${a}, ${b})`, fontSize: size * 0.42 }}
        >
          {[...(name || '?')][0]}
        </span>
      )}
      {status !== undefined && (
        <span
          className={cx('absolute right-0 bottom-0 rounded-full ring-2 ring-white dark:ring-[#1e1b36]', status ? 'bg-emerald-400' : 'bg-zinc-300 dark:bg-zinc-600')}
          style={{ width: Math.max(8, size * 0.26), height: Math.max(8, size * 0.26) }}
        />
      )}
    </span>
  );
}

// ---------- buttons ----------

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && typeof (v as PromiseLike<unknown>).then === 'function';
}

/**
 * Every button that talks to the server shows a spinner and ignores clicks
 * until the request is done: if onClick returns a promise, the button is busy
 * until it settles (a rejection becomes an error toast). Callers just return
 * the promise; nothing else to wire up.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = (r: unknown) => {
    if (!isThenable(r)) return;
    running.current = true;
    setBusy(true);
    Promise.resolve(r)
      .catch(toastError)
      .finally(() => {
        running.current = false;
        if (alive.current) setBusy(false);
      });
  };
  return { busy, running, run };
}

type AsyncClick = (e: MouseEvent<HTMLButtonElement>) => unknown;

function useBusyClick(onClick: AsyncClick | undefined) {
  const { busy, running, run } = useBusy();
  const handler = onClick
    ? (e: MouseEvent<HTMLButtonElement>) => {
        if (running.current) return;
        run(onClick(e));
      }
    : undefined;
  return { busy, handler };
}

type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  variant?: 'primary' | 'soft' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Busy from outside (e.g. a form's onSubmit). Returning a promise from onClick does this automatically. */
  loading?: boolean;
  onClick?: AsyncClick;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'soft', size = 'md', className, loading, onClick, disabled, children, ...rest }, ref) {
  const { busy: clicking, handler } = useBusyClick(onClick);
  const busy = clicking || !!loading;
  return (
    <button
      ref={ref}
      className={cx(
        'press relative inline-flex items-center justify-center rounded-xl font-medium whitespace-nowrap',
        'disabled:cursor-default',
        !busy && 'disabled:opacity-50',
        busy && 'cursor-progress',
        size === 'sm' && 'h-8 px-3 text-[0.85rem]',
        size === 'md' && 'h-10 px-4',
        size === 'lg' && 'h-12 px-6 text-[1.05rem]',
        variant === 'primary' && 'bg-accent text-white shadow-[0_6px_20px_-8px_var(--accent)] hover:bg-accent-600 hover:shadow-[0_10px_24px_-8px_var(--accent)]',
        variant === 'soft' && 'bg-accent-100 text-accent-700 hover:bg-accent-200 dark:bg-white/10 dark:text-accent-200 dark:hover:bg-white/15',
        variant === 'ghost' && 'text-ink-soft hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/10',
        variant === 'danger' && 'bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25',
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handler}
      {...rest}
    >
      <span className={cx('inline-flex items-center gap-2 transition-opacity duration-200', busy && 'opacity-0')}>{children}</span>
      <AnimatePresence>
        {busy && (
          <motion.span
            className="absolute inset-0 flex items-center justify-center"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={spring}
          >
            <Spinner size={size === 'sm' ? 14 : 17} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
});

export function IconButton({ label, active, className, children, onClick, disabled, ...rest }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { label: string; active?: boolean; onClick?: AsyncClick }) {
  const { busy, handler } = useBusyClick(onClick);
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'press inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
        busy && 'cursor-progress',
        active
          ? 'bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]'
          : 'text-ink-soft hover:bg-black/5 hover:text-ink dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white',
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={handler}
      {...rest}
    >
      {busy ? <Spinner size={15} /> : children}
    </button>
  );
}

// ---------- inputs ----------

export const inputClass = cx(
  'w-full rounded-xl border border-black/5 bg-white/70 px-4 outline-none transition-[background,box-shadow,border-color] duration-200',
  'placeholder:text-ink-soft/60 focus:border-accent focus:bg-white focus:shadow-[0_0_0_4px] focus:shadow-accent-100',
  'dark:border-white/10 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:bg-white/10 dark:focus:shadow-accent/20',
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('h-11', inputClass, className)} {...rest} />;
});

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[0.85rem] font-medium text-ink-soft dark:text-white/60">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[0.8rem] text-ink-soft/80 dark:text-white/40">{hint}</span>}
    </label>
  );
}

/** onChange may return a promise (a server call): the switch is locked and shows a spinner until it settles. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => unknown; label: string; disabled?: boolean }) {
  const { busy, running, run } = useBusy();
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
      onClick={() => !running.current && run(onChange(!checked))}
      className={cx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-300 disabled:cursor-default',
        checked ? 'bg-accent' : 'bg-black/15 dark:bg-white/15',
        disabled && !busy && 'opacity-50',
      )}
    >
      <motion.span layout transition={spring} className={cx('absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-accent shadow', checked ? 'right-0.5' : 'left-0.5')}>
        {busy && <Spinner size={11} />}
      </motion.span>
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, id }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; id: string;
}) {
  return (
    <div className="inline-flex rounded-xl bg-black/5 p-1 dark:bg-white/5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('relative h-8 rounded-lg px-3.5 text-[0.9rem] transition-colors', value === o.value ? 'text-accent-700 dark:text-white' : 'text-ink-soft hover:text-ink dark:text-white/60 dark:hover:text-white')}
        >
          {value === o.value && <motion.span layoutId={`seg-${id}`} transition={spring} className="absolute inset-0 rounded-lg bg-white shadow-sm dark:bg-white/15" />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, label }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--accent)]"
      style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, rgb(127 127 127 / 0.25) ${pct}%)` }}
    />
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
      aria-label="加载中"
    />
  );
}

/** "AI · 主人：xx" / "Bot · 主人：xx" chip next to non-human names. Server-stamped, cannot be faked. */
export function IdentityChip({ user, short }: { user?: User; short?: boolean }) {
  if (!user || user.type === 'human') return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-gradient-to-r from-accent to-violet-500 px-1.5 py-px text-[0.7rem] font-semibold text-white">
      {user.type === 'ai' ? 'AI' : 'Bot'}
      {!short && user.ownerName && <span className="font-normal opacity-90">· 主人：{user.ownerName}</span>}
    </span>
  );
}

export function RoleChip({ role }: { role?: 'owner' | 'admin' | 'member' }) {
  if (!role || role === 'member') return null;
  return (
    <span
      className={cx(
        'shrink-0 rounded-md px-1.5 py-px text-[0.7rem] font-semibold',
        role === 'owner' ? 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300',
      )}
    >
      {role === 'owner' ? '群主' : '管理员'}
    </span>
  );
}

// ---------- dialog ----------

export function Dialog({ open, onClose, title, children, width = 440 }: {
  open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // Portal to <body>: a parent with backdrop-filter (the glass panels) would
  // otherwise become the containing block and trap the fixed overlay inside it.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-center justify-center bg-[#15132a]/30 p-6 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={ease}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className="glass-strong max-h-full w-full overflow-y-auto rounded-3xl p-6 shadow-2xl"
            style={{ maxWidth: width }}
            initial={{ opacity: 0, scale: 0.94, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
            transition={spring}
          >
            {title && (
              <div className="mb-4 flex items-center gap-3">
                <h2 className="flex-1 text-[1.15rem] font-semibold">{title}</h2>
                <IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/**
 * Ask for confirmation, optionally with a text input. Resolves to the input
 * (or '') or null. With `run`, the confirm button stays busy while it runs
 * and the dialog closes only when it succeeds (errors are shown as a toast
 * and the dialog stays open).
 */
interface AskState {
  req: {
    title: string; text?: string; ok: string; danger?: boolean;
    input?: { label: string; placeholder?: string; required?: boolean };
    run?: (value: string) => Promise<unknown>;
  } | null;
  resolve: ((v: string | null) => void) | null;
}
const useAsk = create<AskState>(() => ({ req: null, resolve: null }));
export function ask(req: NonNullable<AskState['req']>): Promise<string | null> {
  return new Promise((resolve) => useAsk.setState({ req, resolve }));
}
export function AskHost() {
  const { req, resolve } = useAsk();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue('');
    setBusy(false);
  }, [req]);
  const done = (v: string | null) => {
    resolve?.(v);
    useAsk.setState({ req: null, resolve: null });
  };
  const confirm = async () => {
    if (!req || busy) return;
    if (req.input?.required && !value.trim()) return;
    const v = value.trim();
    if (!req.run) return done(v);
    setBusy(true);
    try {
      await req.run(v);
      done(v);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!req} onClose={() => !busy && done(null)} title={req?.title}>
      {req && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          {req.text && <p className="text-ink-soft dark:text-white/60">{req.text}</p>}
          {req.input && (
            <Field label={req.input.label}>
              <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={req.input.placeholder} maxLength={200} disabled={busy} />
            </Field>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => done(null)} disabled={busy}>取消</Button>
            <Button type="submit" variant={req.danger ? 'danger' : 'primary'} autoFocus={!req.input} loading={busy}>{req.ok}</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------- menu ----------

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  /** May return a promise (server call): the same action can't run twice at once; errors become a toast. */
  onClick: () => unknown;
  /** Identifies the action for the double-run guard (default: label). Include the target, e.g. `mute:123`. */
  key?: string;
}

const inflight = new Set<string>();
function runMenuItem(it: MenuItem) {
  const key = it.key ?? it.label;
  if (inflight.has(key)) return;
  const r = it.onClick();
  if (!isThenable(r)) return;
  inflight.add(key);
  Promise.resolve(r)
    .catch(toastError)
    .finally(() => inflight.delete(key));
}

const useMenu = create<{ at: { x: number; y: number } | null; items: MenuItem[] }>(() => ({ at: null, items: [] }));
export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuItem[]) {
  e.preventDefault?.();
  if (items.length) useMenu.setState({ at: { x: e.clientX, y: e.clientY }, items });
}
export function MenuHost() {
  const { at, items } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(at.x, window.innerWidth - r.width - 8), y: Math.min(at.y, window.innerHeight - r.height - 8) });
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const close = () => useMenu.setState({ at: null });
    const t = setTimeout(() => {
      window.addEventListener('pointerdown', close, { once: true });
      window.addEventListener('blur', close, { once: true });
    });
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [at]);
  return (
    <AnimatePresence>
      {at && (
        <motion.div
          ref={ref}
          role="menu"
          className="glass-strong fixed z-50 min-w-44 rounded-xl p-1 shadow-xl"
          style={{ left: pos.x, top: pos.y, transformOrigin: 'top left' }}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
          transition={spring}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              onClick={() => {
                useMenu.setState({ at: null });
                runMenuItem(it);
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.9rem] transition-colors',
                it.danger ? 'text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10' : 'hover:bg-accent-50 dark:hover:bg-white/10',
              )}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- toast ----------

const useToasts = create<{ list: { id: number; text: string; error?: boolean }[] }>(() => ({ list: [] }));
let toastId = 0;
export function toast(text: string, error = false) {
  const id = ++toastId;
  useToasts.setState((s) => ({ list: [...s.list.slice(-2), { id, text, error }] }));
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), error ? 4500 : 2400);
}
export function toastError(e: unknown) {
  toast(e instanceof Error ? e.message : String(e), true);
}
export function ToastHost() {
  const list = useToasts((s) => s.list);
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      <AnimatePresence>
        {list.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={spring}
            className={cx(
              'rounded-2xl px-4 py-2.5 text-[0.9rem] shadow-xl backdrop-blur-xl',
              t.error ? 'bg-rose-500/95 text-white' : 'bg-[#2a2440]/90 text-white dark:bg-white/90 dark:text-[#2a2440]',
            )}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Empty({ icon, title, text, children }: { icon?: ReactNode; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
      {icon && <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-accent-100 text-accent dark:bg-accent/15">{icon}</div>}
      <h3 className="text-[1.1rem] font-semibold">{title}</h3>
      {text && <p className="mt-1.5 max-w-sm text-ink-soft dark:text-white/55">{text}</p>}
      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}
