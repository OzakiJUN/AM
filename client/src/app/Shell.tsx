import { useMemo, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, LogIn, MessageCircle, Plus, RefreshCw, Search, Settings, Sparkles, Users, WifiOff } from 'lucide-react';
import { listTime } from '@/lib/format';
import { current, openConv, session, switchServer, useApp, useCurrent, type Page } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import { errorText } from '@/lib/errors';
import { Button, Empty, Field, IdentityChip, Input, Spinner, cx, ease, spring } from '@/ui';
import { ChatView } from './Chat';
import { ContactsPage } from './Contacts';
import { ConvAvatar, ServerAvatar, UserAvatar } from './media';
import { MePage } from './Me';
import { SettingsPage } from './Settings';
import logo from '@/assets/logo.png';

/** Main window: nav bar | page. */
export function Shell() {
  const page = useApp((s) => s.page);
  const v = useCurrent();
  let content;
  if (!v) content = <Empty title="还没有服务器" text="点左下角的设置 → 服务器，或者重新粘贴加入码。" />;
  else if (v.status === 'logged_out' && page !== 'settings') content = <LoginAgain v={v} />;
  else if (page === 'chats') content = <><ConversationList v={v} /><ChatView v={v} /></>;
  else if (page === 'contacts') content = <ContactsPage v={v} />;
  else if (page === 'ai') content = <AIPlaceholder />;
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

function unread(v?: SessionView) {
  if (!v) return 0;
  return Object.values(v.convs).reduce((n, c) => n + (c.left ? 0 : Math.max(0, c.lastSeq - c.readSeq)), 0);
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
      {item('chats', '消息', MessageCircle, unread(v))}
      {item('contacts', '联系人', Users, v?.incoming.length)}
      {item('ai', 'AI', Sparkles)}
      <div className="flex-1" />
      {item('settings', '设置', Settings)}
      <button onClick={() => set({ page: 'me' })} aria-label="我" title="我" className="press mt-1 rounded-full">
        <UserAvatar user={v?.me} size={40} status={v?.status === 'online'} />
      </button>
    </nav>
  );
}

const STATUS_TEXT = { connecting: '连接中…', online: '已连接', offline: '已断开', logged_out: '需要登录' };

function ServerSwitcher({ v }: { v: SessionView }) {
  const servers = useApp((s) => s.servers);
  const sessions = useApp((s) => s.sessions);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="lift flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-white/60 dark:hover:bg-white/5"
      >
        <ServerAvatar name={v.name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{v.name}</div>
          <div className="flex items-center gap-1.5 text-[0.78rem] text-ink-soft dark:text-white/50">
            <span className={cx('h-1.5 w-1.5 rounded-full', v.status === 'online' ? 'bg-emerald-400' : v.status === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-rose-400')} />
            {STATUS_TEXT[v.status]}
          </div>
        </div>
        <ChevronDown size={18} className={cx('text-ink-soft transition-transform duration-300 ease-[var(--ease-out)]', open && 'rotate-180')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
            transition={spring}
            style={{ transformOrigin: 'top center' }}
            className="glass-strong absolute top-full right-0 left-0 z-20 mt-2 rounded-2xl p-1.5 shadow-xl"
          >
            {servers.map((s) => {
              const sv = sessions[s.id];
              const n = unread(sv);
              return (
                <button
                  key={s.id}
                  onClick={() => {
                    switchServer(s.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-accent-50 dark:hover:bg-white/5"
                >
                  <ServerAvatar name={sv?.name ?? s.name} size={32} />
                  <span className="min-w-0 flex-1 truncate">{sv?.name ?? s.name}</span>
                  {n > 0 && s.id !== v.id && <span className="rounded-full bg-rose-500 px-1.5 text-[0.7rem] text-white">{n}</span>}
                  {s.id === v.id && <Check size={16} className="text-accent" />}
                </button>
              );
            })}
            <button
              onClick={() => {
                useApp.setState({ view: 'welcome' });
                setOpen(false);
              }}
              className="mt-1 flex w-full items-center gap-3 rounded-xl border-t border-black/5 p-2 text-left text-accent-700 transition-colors hover:bg-accent-50 dark:border-white/5 dark:text-accent-200 dark:hover:bg-white/5"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-100 dark:bg-white/10"><Plus size={18} /></span>
              添加服务器
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ConversationList({ v }: { v: SessionView }) {
  const convId = useApp((s) => s.convId[v.id] ?? null);
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      Object.values(v.convs)
        .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Number(!!a.left) - Number(!!b.left) || b.lastTime - a.lastTime || b.lastSeq - a.lastSeq),
    [v.convs, q],
  );
  return (
    <aside className="glass flex w-[300px] shrink-0 flex-col rounded-3xl p-3">
      <ServerSwitcher v={v} />
      <AnimatePresence>
        {v.status === 'offline' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
            className="overflow-hidden"
          >
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[0.82rem] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
              <WifiOff size={15} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={v.error}>连不上服务器，正在重试</span>
              <button onClick={() => session(v.id)?.reconnectNow()} className="press shrink-0 rounded-lg p-1 hover:bg-rose-100 dark:hover:bg-rose-500/20" aria-label="立即重试">
                <RefreshCw size={14} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="relative my-3">
        <Search size={16} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-soft/70 dark:text-white/40" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索"
          aria-label="搜索会话"
          className="h-9 w-full rounded-xl bg-black/[0.04] pr-3 pl-9 text-[0.9rem] outline-none transition-colors placeholder:text-ink-soft/60 focus:bg-white/80 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:bg-white/10"
        />
      </div>
      <div className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1 pb-1">
        {v.status === 'connecting' && !list.length && (
          <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>
        )}
        {v.status !== 'connecting' && !list.length && (
          <p className="px-4 py-10 text-center text-[0.9rem] text-ink-soft dark:text-white/45">还没有会话。去联系人里加好友、建群吧</p>
        )}
        {list.map((c) => {
          const active = c.id === convId;
          const peer = c.peerId ? v.users[c.peerId] : undefined;
          const n = active ? 0 : Math.max(0, c.lastSeq - c.readSeq);
          return (
            <motion.button
              layout="position"
              transition={spring}
              key={c.id}
              onClick={() => openConv(c.id)}
              className={cx(
                'lift flex w-full items-center gap-3 rounded-2xl p-2.5 text-left',
                active ? 'bg-accent-100/90 shadow-[var(--shadow-card)] dark:bg-white/10' : 'hover:bg-white/70 dark:hover:bg-white/5',
                c.left && 'opacity-60',
              )}
            >
              <ConvAvatar conv={c} peer={peer} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{c.name}</span>
                  <IdentityChip user={peer} short />
                  {c.lastTime > 0 && <span className="ml-auto shrink-0 text-[0.75rem] text-ink-soft/80 dark:text-white/40">{listTime(c.lastTime)}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="truncate text-[0.85rem] text-ink-soft dark:text-white/50">{c.left ? '（已退出）' : c.lastText || ' '}</span>
                  <AnimatePresence>
                    {n > 0 && (
                      <motion.span
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        exit={{ scale: 0 }}
                        transition={spring}
                        className="ml-auto min-w-[20px] shrink-0 rounded-full bg-accent px-1.5 text-center text-[0.72rem] leading-5 font-semibold text-white"
                      >
                        {n > 99 ? '99+' : n}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>
    </aside>
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
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? '请稍候…' : '登录'}</Button>
      </form>
    </section>
  );
}

function AIPlaceholder() {
  return (
    <section className="glass flex flex-1 flex-col rounded-3xl">
      <Empty icon={<Sparkles size={28} />} title="AI 对话栏 · 即将推出" text="填上自己的 API key 就能和各家模型聊天，AI 形象会随情绪变化，还能拉进群、和朋友共用。" />
    </section>
  );
}
