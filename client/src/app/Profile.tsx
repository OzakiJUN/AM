// Profile page: mine (click your avatar in the nav bar) or someone else's
// (their avatar in a chat, "查看主页" in the member list). A big card with
// the animated avatar, name and signature; on my own page my status and
// invisible mode; then the widget board (widgets/Board.tsx, docs/design.md
// §7), with the profile's own background. Editing name / avatar / signature
// is in 账号设置.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { EyeOff, MessageCircle, Pencil, X } from 'lucide-react';
import { ACTIVITIES, ACTIVITY_MAX, presenceText } from '@/lib/presence';
import { current, useApp } from '@/lib/store';
import type { ProfileData, SessionView } from '@/lib/session';
import type { ActivityKind } from '@/lib/types';
import { Button, IdentityChip, Spinner, Toggle, cx, inputClass, spring, toastError } from '@/ui';
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
                @{user?.username}{mine ? ` · ${v.name}` : ` · ${presenceText(p)}`}
              </div>
            </div>
            {mine
              ? <Button variant="soft" onClick={() => useApp.setState({ page: 'account' })}><Pencil size={15} /> 编辑资料</Button>
              : !v.blocked.includes(id) && <Button variant="soft" onClick={() => messageUser(id)}><MessageCircle size={15} /> 发私信</Button>}
          </div>
          <div className="mx-7 mb-6 rounded-2xl bg-black/[0.03] px-4 py-3 whitespace-pre-wrap dark:bg-white/[0.04]">
            {user?.bio || <span className="text-ink-soft/80 dark:text-white/40">{mine ? '还没有个性签名。点「编辑资料」写一句吧。' : '还没有个性签名'}</span>}
          </div>
        </motion.div>

        {mine && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 }}>
            <Status v={v} key={v.id} />
          </motion.div>
        )}

        {data
          ? <Board v={v} target={id} profileKind="user" data={data} owner={user} onChange={setData} reload={load} onBackground={setPreviewBg} />
          : <div className="flex justify-center py-12 text-ink-soft"><Spinner /></div>}
      </div>
    </section>
  );
}

/** Invisible mode and "正在..." activity. */
function Status({ v }: { v: SessionView }) {
  const me = v.me?.id ?? '';
  const p = v.presence[me];
  const online = v.status === 'online';
  const [kind, setKind] = useState<ActivityKind | null>(p?.activity?.kind ?? null);
  const [text, setText] = useState(p?.activity?.text ?? '');
  // Follow changes made on another device.
  useEffect(() => {
    setKind(p?.activity?.kind ?? null);
    setText(p?.activity?.text ?? '');
  }, [p?.activity?.kind, p?.activity?.text]);
  const invisible = !!p?.invisible;
  const info = ACTIVITIES.find((a) => a.kind === kind);
  const saved = p?.activity;
  const changed = (kind ?? null) !== (saved?.kind ?? null) || (kind && text.trim() !== (saved?.text ?? ''));
  const canSave = !!changed && !(kind === 'custom' && !text.trim());

  return (
    <div className="card mt-6 rounded-3xl bg-white/90 p-6 dark:bg-white/[0.06]">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-[1.1rem] font-semibold">我的状态</h2>
        <span className="text-[0.9rem] text-ink-soft dark:text-white/55">{online ? presenceText(p) : '未连接'}</span>
      </div>

      <div className="mt-4 flex items-center gap-4 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-100 text-accent dark:bg-accent/15"><EyeOff size={19} /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">隐身</div>
          <div className="text-[0.85rem] text-ink-soft dark:text-white/50">别人看到你是离线的。你自己的 AI 知道你在线，它可能会说漏嘴。</div>
        </div>
        <Toggle label="隐身" checked={invisible} disabled={!online} onChange={(on) => current().setPresence(on, saved)} />
      </div>

      <div className="mt-5 mb-2 text-[0.85rem] font-medium text-ink-soft dark:text-white/60">正在做什么</div>
      <div className="flex flex-wrap gap-2">
        {ACTIVITIES.map((a) => (
          <button
            key={a.kind}
            onClick={() => setKind(kind === a.kind ? null : a.kind)}
            aria-pressed={kind === a.kind}
            className={cx(
              'lift rounded-xl px-3.5 py-2 text-[0.9rem]',
              kind === a.kind ? 'bg-accent text-white shadow-[0_8px_20px_-10px_var(--accent)]' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/5 dark:hover:bg-white/10',
            )}
          >
            {a.emoji} {a.label}
          </button>
        ))}
      </div>
      {info && (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={ACTIVITY_MAX}
          placeholder={info.hint}
          aria-label={info.hint}
          className={cx(inputClass, 'mt-3 h-11 max-w-md')}
        />
      )}
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" disabled={!online || !canSave} onClick={() => current().setPresence(invisible, kind ? { kind, text: text.trim() } : undefined)}>
          保存状态
        </Button>
        {saved && (
          <Button variant="ghost" disabled={!online} onClick={() => current().setPresence(invisible, undefined)}>
            <X size={15} /> 清除
          </Button>
        )}
      </div>
    </div>
  );
}
