// Profile page: mine (click your avatar in the nav bar) or someone else's
// (their avatar in a chat, "查看主页" in the member list). A big card with
// the animated avatar, name, status and signature, then the widget board
// (widgets/Board.tsx, docs/design.md §7), with the profile's own
// background. Only for looking: name / avatar / signature / status / invisible
// are changed in 账号设置.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { MessageCircle, Pencil, Users } from 'lucide-react';
import { presenceText } from '@/lib/presence';
import { current, openConv, useApp } from '@/lib/store';
import type { ProfileData, SessionView } from '@/lib/session';
import { Button, IdentityChip, Spinner, spring, toast, toastError } from '@/ui';
import type { Background } from '@/lib/widgets';
import { UserAvatar } from './media';
import { messageUser } from './People';
import { Board, ProfileBg } from './widgets/Board';

export function ProfilePage({ v }: { v: SessionView }) {
  const other = useApp((s) => s.profileUser);
  const id = other ?? v.me?.id ?? '';
  const mine = !other || other === v.me?.id;
  const [data, setData] = useState<ProfileData | null>(null);
  const [previewBg, setPreviewBg] = useState<Background | null>(null);
  const load = useCallback(() => {
    if (id) current().getProfile(id).then(setData).catch(toastError);
  }, [id]);
  useEffect(() => {
    setData(null);
    load();
  }, [load, v.id]);
  const user = mine ? v.me : v.users[id] ?? data?.user;
  const p = user ? v.presence[user.id] : undefined;
  return (
    <section className="glass relative flex-1 overflow-hidden rounded-3xl">
      {data && <ProfileBg bg={previewBg ?? data.layout.background} />}
      <div className="relative h-full overflow-y-auto p-8">
        <motion.div key={id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="card relative overflow-hidden rounded-3xl bg-white/90 dark:bg-[#211c38]/90">
          <div className="h-28 bg-gradient-to-br from-accent-200 via-accent-100 to-violet-100 dark:from-accent/40 dark:via-accent/20 dark:to-violet-500/20" />
          <div className="flex flex-wrap items-end gap-5 px-7 pb-6">
            <div className="-mt-14 rounded-full bg-white p-1.5 shadow-[var(--shadow-card)] dark:bg-[#24203c]">
              <UserAvatar user={user} size={112} animated presence />
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <h1 className="flex items-center gap-2 text-[1.6rem] font-bold">
                <span className="truncate">{user?.name ?? '…'}</span>
                <IdentityChip user={user} />
              </h1>
              <div className="text-ink-soft dark:text-white/55">
                @{user?.username}{mine ? ` · ${v.name} · ${v.status === 'online' ? presenceText(p) : '未连接'}` : ` · ${presenceText(p)}`}
              </div>
            </div>
            {mine
              ? <Button variant="soft" onClick={() => useApp.setState({ page: 'account' })}><Pencil size={15} /> 编辑资料</Button>
              : !v.blocked.includes(id) && (
                <div className="flex flex-wrap gap-2">
                  {user && user.type !== 'human' && user.ownerId && user.ownerId !== v.me?.id && v.me?.type === 'human' && <ShareButton v={v} aiId={id} />}
                  <Button variant="soft" onClick={() => messageUser(id)}><MessageCircle size={15} /> 发私信</Button>
                </div>
              )}
          </div>
          <div className="mx-7 mb-6 rounded-2xl bg-black/[0.03] px-4 py-3 whitespace-pre-wrap dark:bg-white/[0.04]">
            {user?.bio || <span className="text-ink-soft/80 dark:text-white/40">{mine ? '还没有个性签名。点「编辑资料」写一句吧。' : '还没有个性签名'}</span>}
          </div>
        </motion.div>

        {data
          ? <Board v={v} target={id} profileKind="user" data={data} owner={user} onChange={setData} reload={load} onBackground={setPreviewBg} />
          : <div className="flex justify-center py-12 text-ink-soft"><Spinner /></div>}
      </div>
    </section>
  );
}

/**
 * Someone else's AI: ask its owner to let me into its shared chat
 * (docs/design.md §9 共享 AI). Already in it = a button to go there.
 */
function ShareButton({ v, aiId }: { v: SessionView; aiId: string }) {
  const room = Object.values(v.convs).find((c) => c.aiId === aiId && !c.left);
  if (room) return <Button variant="soft" onClick={() => openConv(room.id)}><Users size={15} /> 去共享聊天</Button>;
  return (
    <Button variant="primary" onClick={() => current().requestShare(aiId).then(() => toast('申请发出去了，主人同意后你会进它的共享聊天'))}>
      <Users size={15} /> 申请和它聊
    </Button>
  );
}
