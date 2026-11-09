import { type FormEvent, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Hash, KeyRound, LogIn, MessageCircle, Plus, Server, Settings, Sparkles, Store, UserRound } from 'lucide-react';
import { WorkshopPage } from './Workshop';
import { current, openProfile, useApp, useCurrent, useOpenConv, type Page } from '@/lib/store';
import { useNarrow } from '@/lib/layout';
import { useBack } from '@/lib/back';
import { activityText } from '@/lib/presence';
import type { SessionView } from '@/lib/session';
import { errorText } from '@/lib/errors';
import { rememberLogin, savedPassword, useIdentity } from '@/lib/identity';
import { useDevices } from '@/lib/devices';
import { Button, Empty, Field, IconButton, Input, cx, ease, spring, toast } from '@/ui';
import { AIPage } from './AI';
import { ChatView } from './Chat';
import { ConvList } from './ConvList';
import { AccountPage } from './Account';
import { UserAvatar } from './media';
import { ProfilePage } from './Profile';
import { ServerProfilePage } from './ServerProfile';
import { SettingsPage } from './Settings';
import { unread } from './unread';
import { updateAvailable, useUpdate } from '@/lib/update';
import logo from '@/assets/logo.png';

/** Main window: nav bar | page. 频道 and 私信 are list + chat; AI has its own list. */
export function Shell() {
  const page = useApp((s) => s.page);
  const v = useCurrent();
  useOfferToast();
  if (useNarrow()) return <PhoneShell v={v} page={page} />;
  let content;
  if (page === 'workshop') content = <WorkshopPage />;
  else if (!v) content = page === 'settings' ? <SettingsPage /> : <NoServer />;
  else if (v.status === 'logged_out' && page !== 'settings') content = <LoginAgain v={v} />;
  else if (page === 'channels' || page === 'dms') content = <><ConvList v={v} page={page} /><ChatView v={v} page={page} /></>;
  else if (page === 'ai') content = <AIPage v={v} />;
  else if (page === 'account') content = <AccountPage v={v} />;
  else if (page === 'profile') content = <ProfilePage v={v} />;
  else if (page === 'server') content = <ServerProfilePage v={v} />;
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

// ---------- phone layout (lib/layout.ts): one thing at a time + tab bar ----------

const TABS: Page[] = ['channels', 'dms', 'ai', 'me'];
const SUB_TITLE: Partial<Record<Page, string>> = { account: '账号设置', settings: '设置', workshop: '创意工坊', profile: '个人主页', server: '服务器主页' };
/** The tab a sub-page (settings, a profile …) goes back to. */
let lastTab: Page = 'channels';

function PhoneShell({ v, page }: { v?: SessionView; page: Page }) {
  const set = useApp((s) => s.set);
  if (TABS.includes(page)) lastTab = page;
  const sub = !TABS.includes(page);
  useBack(sub, () => set({ page: lastTab }));
  const chatOpen = useOpenConv(page === 'dms' || page === 'ai' ? page : 'channels', v?.id ?? '');
  const inChat = !sub && page !== 'me' && !!v && !!chatOpen && !!v.convs[chatOpen];
  let content;
  if (page === 'me') content = <MePage v={v} />;
  else if (page === 'workshop') content = <WorkshopPage />;
  else if (!v) content = page === 'settings' ? <SettingsPage /> : <NoServer />;
  else if (v.status === 'logged_out' && page !== 'settings') content = <LoginAgain v={v} />;
  else if (page === 'channels' || page === 'dms') content = inChat ? <ChatView v={v} page={page} /> : <ConvList v={v} page={page} />;
  else if (page === 'ai') content = <AIPage v={v} />;
  else if (page === 'account') content = <AccountPage v={v} />;
  else if (page === 'profile') content = <ProfilePage v={v} />;
  else if (page === 'server') content = <ServerProfilePage v={v} />;
  else content = <SettingsPage />;
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {sub && (
        <div className="glass flex h-12 shrink-0 items-center gap-1 rounded-2xl px-1.5">
          <IconButton label="返回" onClick={() => set({ page: lastTab })}><ChevronLeft size={22} /></IconButton>
          <h1 className="text-[1.05rem] font-semibold">{SUB_TITLE[page]}</h1>
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={page + (inChat ? `-${chatOpen}` : '') + (v?.status === 'logged_out' ? '-login' : '')}
          className="flex min-h-0 min-w-0 flex-1 gap-2 overflow-y-auto"
          initial={{ opacity: 0, x: inChat || sub ? 24 : 0, y: inChat || sub ? 0 : 8 }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={ease}
        >
          {content}
        </motion.div>
      </AnimatePresence>
      {!sub && !inChat && <TabBar v={v} />}
    </div>
  );
}

function TabBar({ v }: { v?: SessionView }) {
  const newVersion = useUpdate(updateAvailable);
  const page = useApp((s) => s.page);
  const set = useApp((s) => s.set);
  const tab = (p: Page, label: string, Icon: typeof MessageCircle, badge?: number) => (
    <button
      key={p}
      onClick={() => set({ page: p })}
      aria-label={label}
      aria-current={page === p ? 'page' : undefined}
      className={cx('press relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl py-1.5 text-[0.7rem]', page === p ? 'text-accent-700 dark:text-white' : 'text-ink-soft dark:text-white/55')}
    >
      {page === p && <motion.span layoutId="tab-active" transition={spring} className="absolute inset-x-2 inset-y-0 rounded-2xl bg-accent-100/90 dark:bg-white/10" />}
      <Icon size={21} strokeWidth={page === p ? 2.3 : 2} className="relative" />
      <span className="relative">{label}</span>
      {!!badge && (
        <span className="absolute top-0.5 left-1/2 ml-2 min-w-[17px] rounded-full bg-rose-500 px-1 text-[0.66rem] leading-[17px] font-semibold text-white ring-2 ring-white dark:ring-[#1e1b36]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
  return (
    <nav className="glass flex h-16 shrink-0 items-stretch gap-1 rounded-3xl px-1.5 py-1.5" aria-label="主导航">
      {tab('channels', '频道', Hash, unread(v, 'channels'))}
      {tab('dms', '私信', MessageCircle, unread(v, 'dms'))}
      {tab('ai', 'AI', Sparkles, unread(v, 'ai'))}
      {tab('me', '我', UserRound, newVersion ? 1 : 0)}
    </nav>
  );
}

/** The 「我」 tab: me at the top, then the pages the desktop nav bar has. */
function MePage({ v }: { v?: SessionView }) {
  const newVersion = useUpdate(updateAvailable);
  const set = useApp((s) => s.set);
  const me = v?.me;
  const presence = me ? v?.presence[me.id] : undefined;
  const row = (p: Page, label: string, Icon: typeof MessageCircle, hint?: string) => (
    <button key={p} onClick={() => set({ page: p })} className="press flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left hover:bg-white/70 dark:hover:bg-white/5">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-100 text-accent-700 dark:bg-accent/15 dark:text-accent-200"><Icon size={18} /></span>
      <span className="flex-1 text-[0.95rem]">{label}</span>
      {hint && <span className="rounded-full bg-rose-500 px-2 text-[0.72rem] leading-5 font-semibold text-white">{hint}</span>}
      <ChevronRight size={18} className="text-ink-soft/60" />
    </button>
  );
  return (
    <section className="glass flex flex-1 flex-col gap-2 overflow-y-auto rounded-3xl p-3">
      {me && (
        <button onClick={() => openProfile(null)} className="press flex items-center gap-4 rounded-2xl bg-white/60 p-4 text-left shadow-[var(--shadow-card)] dark:bg-white/5">
          <UserAvatar user={me} size={56} presence />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[1.15rem] font-semibold">{me.name}</span>
            <span className="block truncate text-[0.82rem] text-ink-soft dark:text-white/50">@{me.username} · {presence ? activityText(presence.activity) || '在线' : '离线'}</span>
          </span>
          <ChevronRight size={18} className="text-ink-soft/60" />
        </button>
      )}
      <div className="mt-1 space-y-0.5">
        {me && row('profile', '个人主页', UserRound)}
        {v && row('account', '账号设置', KeyRound)}
        {v && row('server', '服务器主页', Server)}
        {row('workshop', '创意工坊', Store)}
        {row('settings', '设置', Settings, newVersion ? '新版本' : undefined)}
      </div>
    </section>
  );
}

function NavBar({ v }: { v?: SessionView }) {
  const newVersion = useUpdate(updateAvailable);
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
      {item('workshop', '创意工坊', Store)}
      <div className="flex-1" />
      {item('account', '账号设置', UserRound)}
      {item('settings', '设置', Settings, newVersion ? 1 : 0)}
      <button
        onClick={() => openProfile(null)}
        aria-label="个人主页"
        title="个人主页"
        aria-current={page === 'profile' ? 'page' : undefined}
        className={cx('press mt-1 rounded-full ring-offset-2 ring-offset-transparent transition-shadow duration-300', page === 'profile' && 'ring-2 ring-accent')}
      >
        <UserAvatar user={v?.me} size={40} presence />
      </button>
    </nav>
  );
}

function NoServer() {
  return (
    <section className="glass flex flex-1 flex-col rounded-3xl">
      <Empty icon={<Server size={28} />} title="还没有服务器" text="向服主要一个加入码，粘贴进来就能加入。">
        <Button variant="primary" onClick={() => useApp.setState({ view: 'welcome' })}><Plus size={16} /> 加入服务器</Button>
      </Empty>
    </section>
  );
}

function LoginAgain({ v }: { v: SessionView }) {
  const saved = useIdentity();
  const [username, setUsername] = useState(saved.username);
  const [password, setPassword] = useState('');
  const [savedPw, setSavedPw] = useState<string | null>(null);
  const [error, setError] = useState(v.error ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    savedPassword().then((p) => alive && setSavedPw(p));
    return () => {
      alive = false;
    };
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const pw = savedPw ?? password;
    try {
      await current().login(username.trim(), pw);
      void rememberLogin(username.trim(), pw);
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
        <Field label="用户名"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus={!username} /></Field>
        {savedPw !== null ? (
          <div className="flex items-center gap-2 rounded-2xl bg-black/[0.03] px-4 py-3 text-[0.9rem] dark:bg-white/[0.04]">
            <KeyRound size={16} className="text-accent" />
            <span className="flex-1">密码用这台设备保存的</span>
            <button type="button" onClick={() => setSavedPw(null)} className="text-[0.85rem] text-accent-700 hover:underline dark:text-accent-200">换一个</button>
          </div>
        ) : (
          <Field label="密码"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus={!!username} /></Field>
        )}
        {error && <p className="text-[0.85rem] text-rose-500" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>登录</Button>
      </form>
    </section>
  );
}

/** Tells once when another device of mine joined a server (offered in the server list). */
function useOfferToast() {
  const offers = useDevices((s) => s.offers);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const fresh = offers.filter((o) => !seen.current.has(o.endpoint.address + o.endpoint.pin));
    for (const o of offers) seen.current.add(o.endpoint.address + o.endpoint.pin);
    if (fresh.length) toast(`你在另一台设备上加入了「${fresh.map((o) => o.name).join('」「')}」，点上面的服务器列表就能在这里加入`);
  }, [offers]);
}
