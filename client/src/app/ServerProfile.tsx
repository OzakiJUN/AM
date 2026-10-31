// Server profile page (click a server's avatar in the server list). Same
// idea as the personal profile: a big card (icon, name, description, member
// and online counts) and the widget grid. The site admin sets it up in the
// admin panel (icon, description, who may edit the widgets). "退出服务器" in
// the top-right corner leaves the server for good: coming back needs a new
// invite code.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { LogOut, Users } from 'lucide-react';
import { current, leaveServer } from '@/lib/store';
import type { ProfileData, ServerProfileView, SessionView } from '@/lib/session';
import { Button, Spinner, ask, spring, toastError } from '@/ui';
import type { Background } from '@/lib/widgets';
import { ServerAvatar } from './media';
import { Board, ProfileBg } from './widgets/Board';

export function ServerProfilePage({ v }: { v: SessionView }) {
  const [p, setP] = useState<ServerProfileView | null>(null);
  const [data, setData] = useState<ProfileData | null>(null);
  const [previewBg, setPreviewBg] = useState<Background | null>(null);
  const load = useCallback(() => {
    current().getProfile('server').then(setData).catch(toastError);
  }, []);
  useEffect(() => {
    setP(null);
    setData(null);
    current().serverProfile().then(setP).catch(toastError);
    load();
  }, [v.id, load]);

  const leave = () =>
    ask({
      title: `退出「${v.name}」？`,
      text: '你会退出这个服务器的所有频道，并在所有设备上登出，别人在成员列表里也看不到你了。你自己建的频道会交给里面的下一个人（没有其他人的频道会解散）。账号和发过的消息还在，但要回来得找服主要一个新的邀请码。',
      ok: '退出服务器',
      danger: true,
      run: () => leaveServer(v.id),
    });

  return (
    <section className="glass relative flex-1 overflow-hidden rounded-3xl">
      {data && <ProfileBg bg={previewBg ?? data.layout.background} />}
      <div className="relative h-full overflow-y-auto p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="card relative overflow-hidden rounded-3xl bg-white/90 dark:bg-[#211c38]/90">
        <div className="h-28 bg-gradient-to-br from-teal-200 via-accent-100 to-sky-100 dark:from-teal-500/30 dark:via-accent/20 dark:to-sky-500/20" />
        <div className="absolute top-4 right-4">
          <Button variant="danger" size="sm" onClick={leave}>
            <LogOut size={15} /> 退出服务器
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-5 px-7 pb-6">
          <div className="-mt-14 rounded-[34px] bg-white p-1.5 shadow-[var(--shadow-card)] dark:bg-[#24203c]">
            <ServerAvatar name={v.name} icon={p?.icon ?? v.icon} serverId={v.id} size={112} />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="truncate text-[1.6rem] font-bold">{p?.name || v.name}</h1>
            <div className="flex items-center gap-3 text-ink-soft dark:text-white/55">
              {p ? (
                <>
                  <span className="flex items-center gap-1"><Users size={15} /> {p.members} 位成员</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-400" /> {p.online} 人在线</span>
                </>
              ) : (
                <Spinner size={14} />
              )}
            </div>
          </div>
        </div>
        <div className="mx-7 mb-6 rounded-2xl bg-black/[0.03] px-4 py-3 whitespace-pre-wrap dark:bg-white/[0.04]">
          {p?.description || <span className="text-ink-soft/80 dark:text-white/40">服主还没写简介{v.isAdmin ? '。在服务器的管理面板「设置 → 服务器主页」里写。' : '。'}</span>}
        </div>
      </motion.div>
      {data
        ? <Board v={v} target="server" profileKind="server" data={data} onChange={setData} reload={load} onBackground={setPreviewBg} />
        : <div className="flex justify-center py-12 text-ink-soft"><Spinner /></div>}
      </div>
    </section>
  );
}
