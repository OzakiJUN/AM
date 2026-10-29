import { type FormEvent, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Hash, LogIn, MessageCircle, Settings, Sparkles } from 'lucide-react';
import { current, useApp, useCurrent, type Page } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import { errorText } from '@/lib/errors';
import { Button, Empty, Field, Input, cx, ease, spring } from '@/ui';
import { AIPage } from './AI';
import { ChatView } from './Chat';
import { ConvList } from './ConvList';
import { UserAvatar } from './media';
import { MePage } from './Me';
import { SettingsPage } from './Settings';
import { unread } from './unread';
import logo from '@/assets/logo.png';

/** Main window: nav bar | page. 频道 and 私信 are list + chat; AI has its own list. */
export function Shell() {
  const page = useApp((s) => s.page);
  const v = useCurrent();
  let content;
  if (!v) content = <Empty title="还没有服务器" text="点左下角的设置 → 服务器，或者重新粘贴加入码。" />;
  else if (v.status === 'logged_out' && page !== 'settings') content = <LoginAgain v={v} />;
  else if (page === 'channels' || page === 'dms') content = <><ConvList v={v} page={page} /><ChatView v={v} page={page} /></>;
  else if (page === 'ai') content = <AIPage v={v} />;
  else if (page === 'me') content = <MePage v={v} />;
  else content = <SettingsPage />;
  return (
    <div className="flex h-full gap-3 p-3">
      <NavBar v={v} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={page + (v?.status === 'logged_out' ? '-login' : '')}
          className="flex min-w-0 flex-1 gap-3"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.14 } }}
          transition={ease}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function NavBar({ v }: { v?: SessionView }) {
  const page = useApp((s) => s.page);
  const set = useApp((s) => s.set);
  const item = (p: Page, label: string, Icon: typeof MessageCircle, badge?: number) => (
    <button
      key={p}
      onClick={() => set({ page: p })}
      aria-label={label}
      title={label}
      aria-current={page === p ? 'page' : undefined}
      className={cx(
        'press relative flex h-12 w-12 items-center justify-center rounded-2xl',
        page === p ? 'text-white' : 'text-ink-soft hover:bg-white/70 hover:text-ink dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white',
      )}
    >
      {page === p && <motion.span layoutId="nav-active" transition={spring} className="absolute inset-0 rounded-2xl bg-accent shadow-[0_8px_20px_-8px_var(--accent)]" />}
      <Icon size={22} strokeWidth={page === p ? 2.3 : 2} className="relative" />
      <AnimatePresence>
        {!!badge && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={spring}
            className="absolute top-0.5 right-0.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-[0.7rem] leading-[18px] font-semibold text-white ring-2 ring-white dark:ring-[#1e1b36]"
          >
            {badge > 99 ? '99+' : badge}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
  return (
    <nav className="glass flex w-[72px] shrink-0 flex-col items-center gap-2 rounded-3xl py-4">
      <img src={logo} alt="AM" className="mb-3 h-9 w-9" draggable={false} />
      {item('channels', '频道', Hash, unread(v, 'channels'))}
      {item('dms', '私信', MessageCircle, unread(v, 'dms'))}
      {item('ai', 'AI', Sparkles, unread(v, 'ai'))}
      <div className="flex-1" />
      {item('settings', '设置', Settings)}
      <button onClick={() => set({ page: 'me' })} aria-label="我" title="我" className="press mt-1 rounded-full">
        <UserAvatar user={v?.me} size={40} status={v?.status === 'online'} />
      </button>
    </nav>
  );
}

function LoginAgain({ v }: { v: SessionView }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(v.error ?? '');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await current().login(username.trim(), password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="glass flex flex-1 items-center justify-center rounded-3xl p-8">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="mb-2 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-100 text-accent dark:bg-accent/15"><LogIn size={26} /></div>
          <h2 className="text-[1.3rem] font-semibold">登录「{v.name}」</h2>
          <p className="mt-1 text-ink-soft dark:text-white/55">登录已失效或者你退出了，重新登录一下</p>
        </div>
        <Field label="用户名"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus /></Field>
        <Field label="密码"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        {error && <p className="text-[0.85rem] text-rose-500" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>登录</Button>
      </form>
    </section>
  );
}
