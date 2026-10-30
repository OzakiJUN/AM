// Server name + connection state at the top of each list. Click it for the
// list of servers saved on this device: click a name to switch, click an
// avatar to open that server's profile page; "加入新服务器" at the bottom
// goes back to the join screen.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { switchServer, useApp } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import { cx, spring, type MenuItem } from '@/ui';
import { ServerAvatar } from './media';
import { unread } from './unread';

/** Server switching as menu items (used by the folded conversation list). */
export function serverMenuItems(currentId: string): MenuItem[] {
  const { servers, sessions } = useApp.getState();
  return [
    { label: '服务器主页', icon: <ServerAvatar name={sessions[currentId]?.name ?? ''} icon={sessions[currentId]?.icon} serverId={currentId} size={20} />, onClick: () => openServerProfile(currentId) },
    ...servers.filter((s) => s.id !== currentId).map((s): MenuItem => {
      const name = sessions[s.id]?.name ?? s.name;
      const n = unread(sessions[s.id]);
      return {
        label: n ? `切换到 ${name} · ${n} 条未读` : `切换到 ${name}`,
        key: `server:${s.id}`,
        icon: <ServerAvatar name={name} icon={sessions[s.id]?.icon} serverId={s.id} size={20} />,
        onClick: () => switchServer(s.id),
      };
    }),
    { label: '加入新服务器', icon: <Plus size={16} />, onClick: () => useApp.setState({ view: 'welcome' }) },
  ];
}

/** Switches to a server and shows its profile page. */
export function openServerProfile(id: string) {
  switchServer(id);
  useApp.setState({ page: 'server' });
}

const STATUS_TEXT = { connecting: '连接中…', online: '已连接', offline: '已断开', logged_out: '需要登录' };

export function ServerSwitcher({ v }: { v: SessionView }) {
  const servers = useApp((s) => s.servers);
  const sessions = useApp((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label="服务器列表"
        className="lift flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:bg-white/60 dark:hover:bg-white/5"
      >
        <ServerAvatar name={v.name} icon={v.icon} serverId={v.id} />
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
            <div className="px-2 pt-1 pb-1.5 text-[0.72rem] text-ink-soft/80 dark:text-white/40">点头像看服务器主页，点名字切换</div>
            {servers.map((s) => {
              const sv = sessions[s.id];
              const name = sv?.name ?? s.name;
              const n = unread(sv);
              return (
                <div key={s.id} className="flex items-center gap-1 rounded-xl transition-colors hover:bg-accent-50 dark:hover:bg-white/5">
                  <button
                    onClick={() => {
                      openServerProfile(s.id);
                      setOpen(false);
                    }}
                    aria-label={`${name} 的服务器主页`}
                    title="服务器主页"
                    className="lift m-1 rounded-[11px]"
                  >
                    <ServerAvatar name={name} icon={sv?.icon} serverId={s.id} size={34} />
                  </button>
                  <button
                    onClick={() => {
                      switchServer(s.id);
                      setOpen(false);
                    }}
                    aria-label={`切换到 ${name}`}
                    className="flex min-w-0 flex-1 items-center gap-2 self-stretch pr-2 text-left"
                  >
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {n > 0 && s.id !== v.id && <span className="rounded-full bg-rose-500 px-1.5 text-[0.7rem] text-white">{n}</span>}
                    {s.id === v.id && <Check size={16} className="text-accent" />}
                  </button>
                </div>
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
              加入新服务器
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
