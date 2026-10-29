import { useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { listTime } from '@/lib/format';
import { isBotConv, openConv, useApp } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation, User } from '@/lib/types';
import { IdentityChip, cx, spring } from '@/ui';
import { ChatView } from './Chat';
import { UserAvatar } from './media';
import { ServerSwitcher } from './Shell';

/** AI page: nav | your AIs and the ones you added | chat with the portrait on top. */
export function AIPage({ v }: { v: SessionView }) {
  return (
    <>
      <AIList v={v} />
      <ChatView v={v} ai />
    </>
  );
}

interface Row {
  conv: Conversation;
  peer: User;
}

function AIList({ v }: { v: SessionView }) {
  const convId = useApp((s) => s.aiConvId[v.id] ?? null);
  const { mine, added } = useMemo(() => {
    const rows: Row[] = Object.values(v.convs)
      .filter((c) => isBotConv(c, v.users))
      .map((c) => ({ conv: c, peer: v.users[c.peerId!] }))
      .sort((a, b) => b.conv.lastTime - a.conv.lastTime || b.conv.lastSeq - a.conv.lastSeq);
    return { mine: rows.filter((r) => r.peer.ownerId === v.me?.id), added: rows.filter((r) => r.peer.ownerId !== v.me?.id) };
  }, [v.convs, v.users, v.me?.id]);

  const section = (title: string, rows: Row[]) =>
    rows.length > 0 && (
      <div key={title}>
        <div className="px-2 pt-3 pb-1.5 text-[0.75rem] font-medium tracking-wide text-ink-soft/80 dark:text-white/40">{title}</div>
        <div className="space-y-1">
          {rows.map(({ conv, peer }) => {
            const active = conv.id === convId;
            const n = active ? 0 : Math.max(0, conv.lastSeq - conv.readSeq);
            return (
              <motion.button
                layout="position"
                transition={spring}
                key={conv.id}
                onClick={() => openConv(conv.id)}
                className={cx(
                  'lift flex w-full items-center gap-3 rounded-2xl p-2.5 text-left',
                  active ? 'bg-accent-100/90 shadow-[var(--shadow-card)] dark:bg-white/10' : 'hover:bg-white/70 dark:hover:bg-white/5',
                )}
              >
                <UserAvatar user={peer} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{peer.name}</span>
                    <IdentityChip user={peer} short />
                    {conv.lastTime > 0 && <span className="ml-auto shrink-0 text-[0.75rem] text-ink-soft/80 dark:text-white/40">{listTime(conv.lastTime)}</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="truncate text-[0.82rem] text-ink-soft dark:text-white/50">
                      {peer.ownerId === v.me?.id ? '我的' : `主人：${peer.ownerName || '未知'}`}
                    </span>
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
      </div>
    );

  return (
    <aside className="glass flex w-[300px] shrink-0 flex-col rounded-3xl p-3">
      <ServerSwitcher v={v} />
      <div className="-mx-1 mt-2 flex-1 overflow-y-auto px-1 pb-1">
        {section('我的 AI', mine)}
        {section('添加的 AI', added)}
        {!mine.length && !added.length && (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-100 text-accent dark:bg-accent/15"><Sparkles size={22} /></span>
            <p className="text-[0.9rem] text-ink-soft dark:text-white/50">还没有 AI。创建自己的 AI、添加别人的 AI 会在第二阶段上线。</p>
          </div>
        )}
      </div>
    </aside>
  );
}
