// The list column of the 频道 and 私信 pages: server switcher, page actions,
// search, and the conversations that belong to the page.
import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Compass, Lock, Plus, RefreshCw, Search, Users, WifiOff } from 'lucide-react';
import { listTime } from '@/lib/format';
import { convPage, openConv, session, useOpenConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import { IconButton, IdentityChip, Spinner, cx, spring } from '@/ui';
import { BrowseChannelsDialog, CreateChannelDialog } from './Channels';
import { ConvAvatar } from './media';
import { PeopleDialog } from './People';
import { ServerSwitcher } from './ServerSwitcher';
import { convUnread } from './unread';

const PAGES = {
  channels: { title: '频道', empty: '还没有频道。点上面的 + 新建一个，或者浏览公开频道。' },
  dms: { title: '私信', empty: '还没有私信。点上面的成员按钮，找人聊天。' },
} as const;

export function ConvList({ v, page }: { v: SessionView; page: keyof typeof PAGES }) {
  const openId = useOpenConv(page, v.id);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'browse' | 'create' | 'people' | null>(null);
  const list = useMemo(
    () =>
      Object.values(v.convs)
        .filter((c) => convPage(c, v.users) === page)
        .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => Number(!!a.left) - Number(!!b.left) || b.lastTime - a.lastTime || b.lastSeq - a.lastSeq),
    [v.convs, v.users, q, page],
  );

  let actions: ReactNode;
  if (page === 'channels') {
    actions = (
      <>
        <IconButton label="浏览公开频道" onClick={() => setDialog('browse')}><Compass size={18} /></IconButton>
        <IconButton label="新建频道" onClick={() => setDialog('create')}><Plus size={19} /></IconButton>
      </>
    );
  } else {
    actions = <IconButton label="服务器成员" onClick={() => setDialog('people')}><Users size={18} /></IconButton>;
  }

  return (
    <aside className="glass flex w-[300px] shrink-0 flex-col rounded-3xl p-3">
      <ServerSwitcher v={v} />
      <OfflineBanner v={v} />
      <div className="mt-3 flex items-center gap-1 px-1">
        <h2 className="flex-1 text-[0.95rem] font-semibold text-ink-soft dark:text-white/60">{PAGES[page].title}</h2>
        {actions}
      </div>
      <div className="relative my-2">
        <Search size={16} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-soft/70 dark:text-white/40" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索"
          aria-label={`搜索${PAGES[page].title}`}
          className="h-9 w-full rounded-xl bg-black/[0.04] pr-3 pl-9 text-[0.9rem] outline-none transition-colors placeholder:text-ink-soft/60 focus:bg-white/80 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:bg-white/10"
        />
      </div>
      <div className="-mx-1 flex-1 space-y-1 overflow-y-auto px-1 pb-1">
        {v.status === 'connecting' && !list.length && <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>}
        {v.status !== 'connecting' && !list.length && (
          <p className="px-4 py-10 text-center text-[0.9rem] text-ink-soft dark:text-white/45">{q ? '没有找到' : PAGES[page].empty}</p>
        )}
        {list.map((c) => {
          const active = c.id === openId;
          const peer = c.peerId ? v.users[c.peerId] : undefined;
          const n = active ? 0 : convUnread(c);
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
                  {c.kind === 'group' && !c.public && <Lock size={12} className="shrink-0 text-ink-soft/70 dark:text-white/40" aria-label="私密频道" />}
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
      <BrowseChannelsDialog open={dialog === 'browse'} onClose={() => setDialog(null)} />
      <CreateChannelDialog open={dialog === 'create'} onClose={() => setDialog(null)} v={v} />
      <PeopleDialog open={dialog === 'people'} onClose={() => setDialog(null)} v={v} />
    </aside>
  );
}

/** Shown under the server switcher while the connection is down. */
export function OfflineBanner({ v }: { v: SessionView }) {
  return (
    <AnimatePresence>
      {v.status === 'offline' && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring} className="overflow-hidden">
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
  );
}
