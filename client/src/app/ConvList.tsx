// The list column of the 频道 and 私信 pages: server switcher, page actions,
// search, and the conversations that belong to the page.
import { useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, BellOff, Compass, Lock, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Plus, RefreshCw, Search, Users, WifiOff } from 'lucide-react';
import { listTime } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { convPage, openConv, session, useOpenConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import { IconButton, IdentityChip, Spinner, cx, openMenu, spring, type MenuItem } from '@/ui';
import { BrowseChannelsDialog, CreateChannelDialog } from './Channels';
import { FoldColumn, StripItem } from './Fold';
import { ConvAvatar } from './media';
import { PeopleDialog } from './People';
import { ServerSwitcher, serverMenuItems } from './ServerSwitcher';
import { byListOrder, convUnread, isDnd } from './unread';
import type { Conversation } from '@/lib/types';

const PAGES = {
  channels: { title: '频道', empty: '还没有频道。点上面的 + 新建一个，或者浏览公开频道。' },
  dms: { title: '私信', empty: '还没有私信。点上面的成员按钮，找人聊天。' },
} as const;

export function ConvList({ v, page }: { v: SessionView; page: keyof typeof PAGES }) {
  const openId = useOpenConv(page, v.id);
  const folded = usePrefs((p) => p.listFolded);
  const setPrefs = usePrefs((p) => p.set);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<'browse' | 'create' | 'people' | null>(null);
  const list = useMemo(
    () =>
      Object.values(v.convs)
        .filter((c) => convPage(c, v.users) === page)
        .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
        .sort(byListOrder),
    [v.convs, v.users, q, page],
  );

  let actions: ReactNode;
  let actionItems: MenuItem[];
  if (page === 'channels') {
    actions = (
      <>
        <IconButton label="浏览公开频道" onClick={() => setDialog('browse')}><Compass size={18} /></IconButton>
        <IconButton label="新建频道" onClick={() => setDialog('create')}><Plus size={19} /></IconButton>
      </>
    );
    actionItems = [
      { label: '浏览公开频道', icon: <Compass size={16} />, onClick: () => setDialog('browse') },
      { label: '新建频道', icon: <Plus size={16} />, onClick: () => setDialog('create') },
    ];
  } else {
    actions = <IconButton label="服务器成员" onClick={() => setDialog('people')}><Users size={18} /></IconButton>;
    actionItems = [{ label: '服务器成员', icon: <Users size={16} />, onClick: () => setDialog('people') }];
  }

  const strip = (
    <ListStrip v={v} onUnfold={() => setPrefs({ listFolded: false })} menu={actionItems}>
      {list.map((c) => {
        const peer = c.peerId ? v.users[c.peerId] : undefined;
        const active = c.id === openId;
        return (
          <StripItem key={c.id} label={c.name} active={active} dim={!!c.left} badge={active || isDnd(c) ? 0 : convUnread(c)} onClick={() => openConv(c.id)} onContextMenu={(e) => openMenu(e, convMenu(v.id, c))}>
            <ConvAvatar conv={c} peer={peer} size={42} />
          </StripItem>
        );
      })}
    </ListStrip>
  );

  const full = (
    <div className="flex h-full flex-col p-3">
      <ServerSwitcher v={v} />
      <OfflineBanner v={v} />
      <div className="mt-3 flex items-center gap-1 px-1">
        <h2 className="flex-1 text-[0.95rem] font-semibold text-ink-soft dark:text-white/60">{PAGES[page].title}</h2>
        {actions}
        <IconButton label="收起列表" onClick={() => setPrefs({ listFolded: true })}><PanelLeftClose size={18} /></IconButton>
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
          const dnd = isDnd(c);
          return (
            <motion.button
              layout="position"
              transition={spring}
              key={c.id}
              onClick={() => openConv(c.id)}
              onContextMenu={(e) => openMenu(e, convMenu(v.id, c))}
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
                  {dnd && <BellOff size={12} className="shrink-0 text-ink-soft/70 dark:text-white/40" aria-label="免打扰" />}
                  {c.pinnedOrder > 0 && <Pin size={12} className="shrink-0 rotate-45 text-accent/80" aria-label="已置顶" />}
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
                        className={cx('ml-auto min-w-[20px] shrink-0 rounded-full px-1.5 text-center text-[0.72rem] leading-5 font-semibold text-white', dnd ? 'bg-zinc-400/80 dark:bg-white/25' : 'bg-accent')}
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
    </div>
  );

  return (
    <>
      <FoldColumn label={PAGES[page].title} folded={folded} width={300} foldedWidth={76} full={full} strip={strip} />
      <BrowseChannelsDialog open={dialog === 'browse'} onClose={() => setDialog(null)} />
      <CreateChannelDialog open={dialog === 'create'} onClose={() => setDialog(null)} v={v} />
      <PeopleDialog open={dialog === 'people'} onClose={() => setDialog(null)} v={v} />
    </>
  );
}

/**
 * The folded list: unfold button, one button holding the server switcher and
 * the page's actions, then a column of avatars.
 */
export function ListStrip({ v, onUnfold, menu, children }: { v: SessionView; onUnfold: () => void; menu: MenuItem[]; children: ReactNode }) {
  const dot = v.status === 'online' ? 'bg-emerald-400' : v.status === 'connecting' ? 'animate-pulse bg-amber-400' : 'bg-rose-400';
  return (
    <div className="flex h-full flex-col items-center gap-1 py-3">
      <IconButton label="展开列表" onClick={onUnfold}><PanelLeftOpen size={18} /></IconButton>
      <button
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openMenu({ clientX: r.right + 6, clientY: r.top }, [...menu, ...serverMenuItems(v.id)]);
        }}
        aria-label={`${v.name}：切换服务器和更多操作`}
        title={v.name}
        className="press relative mt-1 flex h-11 w-11 items-center justify-center rounded-[14px] bg-accent-100 text-accent dark:bg-white/10 dark:text-accent-200"
      >
        <Plus size={20} />
        <span className={cx('absolute top-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-white dark:ring-[#1e1b36]', dot)} />
      </button>
      <div className="my-1.5 h-px w-8 bg-black/10 dark:bg-white/10" />
      <div className="-mx-1 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1 pb-1">{children}</div>
    </div>
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

/** Right-click menu of a channel / DM: pin and do not disturb (my own settings, all my devices). */
function convMenu(serverId: string, c: Conversation): MenuItem[] {
  const s = () => session(serverId)!;
  if (c.left) return [];
  const items: MenuItem[] = [
    c.pinnedOrder > 0
      ? { label: '取消置顶', key: `unpin:${c.id}`, icon: <PinOff size={16} />, onClick: () => s().setPinned(c.id, false) }
      : { label: '置顶', key: `pin:${c.id}`, icon: <Pin size={16} />, onClick: () => s().setPinned(c.id, true) },
  ];
  if (isDnd(c)) {
    items.push({ label: c.dndUntil === -1 ? '关闭免打扰' : `关闭免打扰（到 ${dndEnd(c.dndUntil)}）`, key: `dnd-off:${c.id}`, icon: <Bell size={16} />, onClick: () => s().setDnd(c.id, 0) });
  } else {
    const at = (h: number) => Date.now() + h * 3_600_000;
    items.push(
      { label: '免打扰 1 小时', key: `dnd1:${c.id}`, icon: <BellOff size={16} />, onClick: () => s().setDnd(c.id, at(1)) },
      { label: '免打扰 8 小时', key: `dnd8:${c.id}`, icon: <BellOff size={16} />, onClick: () => s().setDnd(c.id, at(8)) },
      { label: '一直免打扰', key: `dnd:${c.id}`, icon: <BellOff size={16} />, onClick: () => s().setDnd(c.id, -1) },
    );
  }
  return items;
}

function dndEnd(ms: number) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
