import { useEffect, useRef, useState } from 'react';
import { Ban, Check, Crown, ImageUp, LogOut, MessageCircle, PanelRightClose, PanelRightOpen, Shield, ShieldOff, UserMinus, UserPlus, Volume2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { usePrefs } from '@/lib/prefs';
import { activityText } from '@/lib/presence';
import { current } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation, MemberRole } from '@/lib/types';
import { Button, Dialog, Field, IconButton, IdentityChip, Input, RoleChip, Spinner, Toggle, ask, cx, inputClass, openMenu, spring, toast, toastError, type MenuItem } from '@/ui';
import { FoldColumn, StripItem } from './Fold';
import { ConvAvatar, UserAvatar } from './media';
import { PersonPicker, messageUser, toggleBlock } from './People';

const RANK: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };

/** Channel members, online first. Folds into a column of avatars with online dots. */
export function MemberPanel({ v, conv, onInvite }: { v: SessionView; conv: Conversation; onInvite: () => void }) {
  const folded = usePrefs((p) => p.membersFolded);
  const setPrefs = usePrefs((p) => p.set);
  const byRole = [...conv.members].sort((a, b) => RANK[b.role] - RANK[a.role]);
  const online = byRole.filter((m) => v.presence[m.userId]);
  const offline = byRole.filter((m) => !v.presence[m.userId]);
  const requests = v.joinRequests[conv.id] ?? [];
  const canManage = RANK[conv.myRole] >= 2;
  useEffect(() => {
    if (canManage && conv.joinApproval) current().loadJoinRequests(conv.id).catch(() => {});
  }, [canManage, conv.id, conv.joinApproval]);

  const menuFor = (e: React.MouseEvent, userId: string, role: MemberRole) => {
    if (userId === v.me?.id) return;
    const s = current();
    const name = v.users[userId]?.name ?? '对方';
    const user = v.users[userId];
    const blocked = v.blocked.includes(userId);
    const mine = RANK[conv.myRole];
    const items: MenuItem[] = [];
    if (!blocked) items.push({ label: '发私信', key: `dm:${userId}`, icon: <MessageCircle size={16} />, onClick: () => messageUser(userId) });
    if (conv.myRole === 'owner') {
      items.push(role === 'admin'
        ? { label: '取消管理员', key: `admin:${userId}`, icon: <ShieldOff size={16} />, onClick: () => s.setAdmin(conv.id, userId, false).catch(toastError) }
        : { label: '设为管理员', key: `admin:${userId}`, icon: <Shield size={16} />, onClick: () => s.setAdmin(conv.id, userId, true).catch(toastError) });
    }
    if (mine > RANK[role]) {
      for (const [label, sec] of [['禁言 10 分钟', 600], ['禁言 1 小时', 3600], ['禁言 1 天', 86400]] as const) {
        items.push({ label, key: `mute:${userId}`, icon: <Ban size={16} />, onClick: () => s.mute(conv.id, userId, sec).then(() => toast(`已${label}`)).catch(toastError) });
      }
      items.push({ label: '解除禁言', key: `mute:${userId}`, icon: <Volume2 size={16} />, onClick: () => s.mute(conv.id, userId, 0).then(() => toast('已解除禁言')).catch(toastError) });
      items.push({
        label: '移出频道', icon: <UserMinus size={16} />, danger: true,
        onClick: () => ask({ title: `把 ${name} 移出频道？`, ok: '移出', danger: true, run: () => s.removeMember(conv.id, userId) }),
      });
    }
    if (conv.myRole === 'owner') {
      items.push({
        label: '转让频道主', icon: <Crown size={16} />, danger: true,
        onClick: () => ask({ title: `把频道主转让给 ${name}？`, text: '转让后你会变成普通成员。', ok: '转让', danger: true, run: () => s.transfer(conv.id, userId) }),
      });
    }
    items.push({ label: blocked ? '取消屏蔽' : '屏蔽', key: `block:${userId}`, icon: <Ban size={16} />, danger: !blocked, onClick: () => toggleBlock(user, blocked) });
    openMenu(e, items);
  };

  const row = (m: (typeof byRole)[number]) => {
    const u = v.users[m.userId];
    const act = activityText(v.presence[m.userId]?.activity);
    return (
      <motion.button
        layout="position"
        transition={spring}
        key={m.userId}
        onClick={(e) => menuFor(e, m.userId, m.role)}
        onContextMenu={(e) => menuFor(e, m.userId, m.role)}
        className={cx('lift flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/70 dark:hover:bg-white/5', !v.presence[m.userId] && 'opacity-60')}
      >
        <UserAvatar user={u} size={32} presence />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[0.9rem]">{u?.name ?? '…'}{m.userId === v.me?.id && <span className="text-ink-soft"> （我）</span>}</span>
          {act && <span className="block truncate text-[0.75rem] text-ink-soft dark:text-white/45">{act}</span>}
        </span>
        <RoleChip role={m.role} />
        <IdentityChip user={u} short />
      </motion.button>
    );
  };
  const section = (title: string, list: typeof byRole) =>
    list.length > 0 && (
      <div key={title}>
        <div className="px-2 pt-2 pb-1 text-[0.72rem] font-medium tracking-wide text-ink-soft/80 dark:text-white/40">{title} — {list.length}</div>
        {list.map(row)}
      </div>
    );

  const full = (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-0.5">
        <h3 className="flex-1 font-semibold">成员 · {byRole.length}</h3>
        <IconButton label="邀请成员" onClick={onInvite}><UserPlus size={17} /></IconButton>
        <IconButton label="收起成员列表" onClick={() => setPrefs({ membersFolded: true })}><PanelRightClose size={17} /></IconButton>
      </div>
      {canManage && requests.length > 0 && (
        <div className="mb-3 space-y-2 rounded-2xl bg-accent-50 p-2.5 dark:bg-white/5">
          <div className="px-1 text-[0.8rem] font-medium text-accent-700 dark:text-accent-200">加入申请 · {requests.length}</div>
          {requests.map((r) => (
            <div key={r.user.id} className="flex items-center gap-2">
              <UserAvatar user={r.user} size={28} />
              <div className="min-w-0 flex-1 text-[0.82rem] leading-tight">
                <div className="truncate font-medium">{r.user.name}</div>
                <div className="truncate text-ink-soft dark:text-white/45">{r.inviter.name} 邀请</div>
              </div>
              <IconButton label="同意" className="h-7 w-7" onClick={() => current().decideJoin(conv.id, r.user.id, true).catch(toastError)}><Check size={15} /></IconButton>
              <IconButton label="拒绝" className="h-7 w-7" onClick={() => current().decideJoin(conv.id, r.user.id, false).catch(toastError)}><X size={15} /></IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="-mx-2 flex-1 space-y-0.5 overflow-y-auto">
        {section('在线', online)}
        {section('离线', offline)}
      </div>
    </div>
  );

  const strip = (
    <div className="flex h-full flex-col items-center gap-1 py-3">
      <IconButton label="展开成员列表" onClick={() => setPrefs({ membersFolded: false })}><PanelRightOpen size={18} /></IconButton>
      <IconButton label="邀请成员" onClick={onInvite}><UserPlus size={17} /></IconButton>
      {canManage && requests.length > 0 && (
        <button
          onClick={() => setPrefs({ membersFolded: false })}
          title={`${requests.length} 个加入申请`}
          className="press rounded-full bg-accent px-2 text-[0.72rem] leading-5 font-semibold text-white"
        >
          {requests.length}
        </button>
      )}
      <div className="my-1.5 h-px w-7 bg-black/10 dark:bg-white/10" />
      <div className="flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pb-1">
        {[...online, ...offline].map((m) => {
          const u = v.users[m.userId];
          const act = activityText(v.presence[m.userId]?.activity);
          return (
            <StripItem
              key={m.userId}
              label={(u?.name ?? '…') + (act ? ` · ${act}` : '')}
              dim={!v.presence[m.userId]}
              onClick={(e) => menuFor(e, m.userId, m.role)}
              onContextMenu={(e) => menuFor(e, m.userId, m.role)}
            >
              <UserAvatar user={u} size={36} presence />
            </StripItem>
          );
        })}
      </div>
    </div>
  );

  return <FoldColumn label="频道成员" folded={folded} width={250} foldedWidth={68} full={full} strip={strip} />;
}

export function GroupDialog({ open, onClose, v, conv }: { open: boolean; onClose: () => void; v: SessionView; conv: Conversation }) {
  const [name, setName] = useState(conv.name);
  const [notice, setNotice] = useState(conv.notice);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canManage = RANK[conv.myRole] >= 2;
  useEffect(() => {
    if (open) {
      setName(conv.name);
      setNotice(conv.notice);
    }
  }, [open, conv.name, conv.notice]);

  const save = async () => {
    setBusy(true);
    try {
      const patch: { name?: string; notice?: string } = {};
      if (name.trim() !== conv.name) patch.name = name.trim();
      if (notice !== conv.notice) patch.notice = notice;
      if (Object.keys(patch).length) await current().updateGroup(conv.id, patch);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const [uploading, setUploading] = useState(false);
  const avatar = async (f: File) => {
    setUploading(true);
    try {
      const info = await current().upload(f);
      await current().updateGroup(conv.id, { avatarMediaId: info.id });
      toast('频道头像已更新');
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };
  const leave = async () => {
    const s = current();
    const ok = conv.myRole === 'owner'
      ? await ask({ title: `解散「${conv.name}」？`, text: '所有成员都会被移出，聊天记录保留但不能再发消息。不能撤销。', ok: '解散', danger: true, run: () => s.dissolve(conv.id) })
      : await ask({ title: `退出「${conv.name}」？`, ok: '退出', danger: true, run: () => s.removeMember(conv.id, v.me!.id) });
    if (ok !== null) onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="频道设置" width={480}>
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <button className="press relative" disabled={!canManage || uploading} onClick={() => fileRef.current?.click()} aria-label="更换频道头像" aria-busy={uploading || undefined}>
            <ConvAvatar conv={conv} size={64} />
            {uploading && <span className="absolute inset-0 flex items-center justify-center rounded-[30%] bg-black/40 text-white"><Spinner size={20} /></span>}
            {canManage && <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow"><ImageUp size={13} /></span>}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[1.1rem] font-semibold">{conv.name}</div>
            <div className="text-[0.85rem] text-ink-soft dark:text-white/50">{conv.members.length} 位成员 · 你是{conv.myRole === 'owner' ? '频道主' : conv.myRole === 'admin' ? '管理员' : '成员'}</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) avatar(f); e.target.value = ''; }} />
        </div>
        <Field label="频道名">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} disabled={!canManage} />
        </Field>
        <Field label="频道公告">
          <textarea value={notice} onChange={(e) => setNotice(e.target.value)} rows={4} maxLength={1000} disabled={!canManage} className={cx('resize-none py-2.5', inputClass)} placeholder="大家进频道会看到" />
        </Field>
        {canManage && !conv.public && (
          <div className="flex items-center justify-between rounded-2xl bg-black/[0.03] px-4 py-3 dark:bg-white/5">
            <div>
              <div className="font-medium">加入审批</div>
              <div className="text-[0.82rem] text-ink-soft dark:text-white/50">开启后，普通成员拉人要管理员同意</div>
            </div>
            <Toggle label="加入审批" checked={conv.joinApproval} onChange={(on) => current().updateGroup(conv.id, { joinApproval: on }).catch(toastError)} />
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="danger" onClick={leave}><LogOut size={16} />{conv.myRole === 'owner' ? '解散频道' : '退出频道'}</Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {canManage && <Button variant="primary" onClick={save} loading={busy}>保存</Button>}
        </div>
      </div>
    </Dialog>
  );
}

export function InviteDialog({ open, onClose, v, conv }: { open: boolean; onClose: () => void; v: SessionView; conv: Conversation }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (open) setSel(new Set());
  }, [open]);
  const go = async () => {
    try {
      const r = await current().inviteMembers(conv.id, [...sel]);
      toast(r.requested.length ? `已提交加入申请，等管理员同意` : `已邀请 ${r.added.length} 人`);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`邀请成员加入「${conv.name}」`}>
      <PersonPicker v={v} exclude={new Set(conv.members.map((m) => m.userId))} selected={sel} onChange={setSel} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!sel.size} onClick={go}>邀请{sel.size ? ` ${sel.size} 人` : ''}</Button>
      </div>
    </Dialog>
  );
}
