// Profile page (click your avatar in the nav bar): big card with the
// animated avatar, name and signature; your online status and activity; and
// the widget grid that becomes a phone-home-screen-like layout in the next
// batch (docs/design.md §7). Editing name / avatar / signature is in 账号设置.
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { EyeOff, LayoutGrid, Pencil, X } from 'lucide-react';
import { ACTIVITIES, ACTIVITY_MAX, presenceText } from '@/lib/presence';
import { current, useApp } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { ActivityKind } from '@/lib/types';
import { Button, IdentityChip, Toggle, cx, inputClass, spring } from '@/ui';
import { UserAvatar } from './media';

export function ProfilePage({ v }: { v: SessionView }) {
  const me = v.me;
  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="card relative overflow-hidden rounded-3xl bg-white/90 dark:bg-white/[0.06]">
        <div className="h-28 bg-gradient-to-br from-accent-200 via-accent-100 to-violet-100 dark:from-accent/40 dark:via-accent/20 dark:to-violet-500/20" />
        <div className="flex flex-wrap items-end gap-5 px-7 pb-6">
          <div className="-mt-14 rounded-full bg-white p-1.5 shadow-[var(--shadow-card)] dark:bg-[#24203c]">
            <UserAvatar user={me} size={112} animated presence />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="flex items-center gap-2 text-[1.6rem] font-bold">
              <span className="truncate">{me?.name}</span>
              <IdentityChip user={me} />
            </h1>
            <div className="text-ink-soft dark:text-white/55">@{me?.username} · {v.name}</div>
          </div>
          <Button variant="soft" onClick={() => useApp.setState({ page: 'account' })}><Pencil size={15} /> 编辑资料</Button>
        </div>
        <div className="mx-7 mb-6 rounded-2xl bg-black/[0.03] px-4 py-3 whitespace-pre-wrap dark:bg-white/[0.04]">
          {me?.bio || <span className="text-ink-soft/80 dark:text-white/40">还没有个性签名。点「编辑资料」写一句吧。</span>}
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 }}>
        <Status v={v} key={v.id} />
      </motion.div>

      <WidgetGridStub note="以后可以像手机桌面一样在这里摆放签名、在玩的游戏、照片墙、留言板等小组件（下一批上线）。" />
    </section>
  );
}

/** Placeholder for the widget grid of profile pages (widgets: next batch). */
export function WidgetGridStub({ note }: { note: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.1 }} className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-[1.1rem] font-semibold"><LayoutGrid size={19} className="text-accent" /> 主页小组件</h2>
      <div className="grid grid-cols-4 gap-4">
        {['col-span-2 row-span-2', '', '', 'col-span-2'].map((span, i) => (
          <div key={i} className={cx('flex min-h-24 items-center justify-center rounded-3xl border-2 border-dashed border-black/10 text-[0.85rem] text-ink-soft/70 dark:border-white/10 dark:text-white/30', span)}>
            {i === 0 && '小组件即将推出'}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[0.85rem] text-ink-soft dark:text-white/45">{note}</p>
    </motion.div>
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
