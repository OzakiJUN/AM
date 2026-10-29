import { useEffect, useRef, useState } from 'react';
import { Ban, Check, Crown, ImageUp, LogOut, MessageCircle, Shield, ShieldOff, UserMinus, UserPlus, Volume2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { current, openConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation, MemberRole, User } from '@/lib/types';
import { Button, Dialog, Field, IconButton, IdentityChip, Input, RoleChip, Toggle, ask, cx, inputClass, openMenu, spring, toast, toastError, type MenuItem } from '@/ui';
import { ConvAvatar, UserAvatar } from './media';

const RANK: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };

export function MemberPanel({ v, conv, onInvite }: { v: SessionView; conv: Conversation; onInvite: () => void }) {
  const members = [...conv.members].sort((a, b) => RANK[b.role] - RANK[a.role]);
  const requests = v.joinRequests[conv.id] ?? [];
  const canManage = RANK[conv.myRole] >= 2;
  useEffect(() => {
    if (canManage && conv.joinApproval) current().loadJoinRequests(conv.id).catch(() => {});
  }, [canManage, conv.id, conv.joinApproval]);

  const menuFor = (e: React.MouseEvent, userId: string, role: MemberRole) => {
    if (userId === v.me?.id) return;
    const s = current();
    const name = v.users[userId]?.name ?? '对方';
    const isFriend = v.friends.some((f) => f.id === userId);
    const mine = RANK[conv.myRole];
    const items: MenuItem[] = [];
    if (isFriend) items.push({ label: '发消息', icon: <MessageCircle size={16} />, onClick: () => s.openDM(userId).then(openConv).catch(toastError) });
    if (conv.myRole === 'owner') {
      items.push(role === 'admin'
        ? { label: '取消管理员', icon: <ShieldOff size={16} />, onClick: () => s.setAdmin(conv.id, userId, false).catch(toastError) }
        : { label: '设为管理员', icon: <Shield size={16} />, onClick: () => s.setAdmin(conv.id, userId, true).catch(toastError) });
    }
    if (mine > RANK[role]) {
      for (const [label, sec] of [['禁言 10 分钟', 600], ['禁言 1 小时', 3600], ['禁言 1 天', 86400]] as const) {
        items.push({ label, icon: <Ban size={16} />, onClick: () => s.mute(conv.id, userId, sec).then(() => toast(`已${label}`)).catch(toastError) });
      }
      items.push({ label: '解除禁言', icon: <Volume2 size={16} />, onClick: () => s.mute(conv.id, userId, 0).then(() => toast('已解除禁言')).catch(toastError) });
      items.push({
        label: '移出群聊', icon: <UserMinus size={16} />, danger: true,
        onClick: async () => (await ask({ title: `把 ${name} 移出群聊？`, ok: '移出', danger: true })) !== null && s.removeMember(conv.id, userId).catch(toastError),
      });
    }
    if (conv.myRole === 'owner') {
      items.push({
        label: '转让群主', icon: <Crown size={16} />, danger: true,
        onClick: async () => (await ask({ title: `把群主转让给 ${name}？`, text: '转让后你会变成普通成员。', ok: '转让', danger: true })) !== null &&
          s.transfer(conv.id, userId).catch(toastError),
      });
    }
    openMenu(e, items);
  };

  return (
    <aside className="glass flex w-[250px] shrink-0 flex-col rounded-3xl p-4">
      <div className="mb-3 flex items-center">
        <h3 className="flex-1 font-semibold">群成员 · {members.length}</h3>
        <IconButton label="邀请好友" onClick={onInvite}><UserPlus size={17} /></IconButton>
      </div>
      {canManage && requests.length > 0 && (
        <div className="mb-3 space-y-2 rounded-2xl bg-accent-50 p-2.5 dark:bg-white/5">
          <div className="px-1 text-[0.8rem] font-medium text-accent-700 dark:text-accent-200">入群申请 · {requests.length}</div>
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
        {members.map((m) => {
          const u = v.users[m.userId];
          return (
            <motion.button
              layout="position"
              transition={spring}
              key={m.userId}
              onClick={(e) => menuFor(e, m.userId, m.role)}
              onContextMenu={(e) => menuFor(e, m.userId, m.role)}
              className="lift flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/70 dark:hover:bg-white/5"
            >
              <UserAvatar user={u} size={32} />
              <span className="min-w-0 flex-1 truncate text-[0.9rem]">{u?.name ?? '…'}{m.userId === v.me?.id && <span className="text-ink-soft"> （我）</span>}</span>
              <RoleChip role={m.role} />
              <IdentityChip user={u} short />
            </motion.button>
          );
        })}
      </div>
    </aside>
  );
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
  const avatar = async (f: File) => {
    try {
      const info = await current().upload(f);
      await current().updateGroup(conv.id, { avatarMediaId: info.id });
      toast('群头像已更新');
    } catch (e) {
      toastError(e);
    }
  };
  const leave = async () => {
    const s = current();
    if (conv.myRole === 'owner') {
      if ((await ask({ title: `解散「${conv.name}」？`, text: '所有成员都会被移出，聊天记录保留但不能再发消息。不能撤销。', ok: '解散', danger: true })) === null) return;
      await s.dissolve(conv.id).catch(toastError);
    } else {
      if ((await ask({ title: `退出「${conv.name}」？`, ok: '退出', danger: true })) === null) return;
      await s.removeMember(conv.id, v.me!.id).catch(toastError);
    }
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="群设置" width={480}>
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <button className="press relative" disabled={!canManage} onClick={() => fileRef.current?.click()} aria-label="更换群头像">
            <ConvAvatar conv={conv} size={64} />
            {canManage && <span className="absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white shadow"><ImageUp size={13} /></span>}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[1.1rem] font-semibold">{conv.name}</div>
            <div className="text-[0.85rem] text-ink-soft dark:text-white/50">{conv.members.length} 位成员 · 你是{conv.myRole === 'owner' ? '群主' : conv.myRole === 'admin' ? '管理员' : '成员'}</div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) avatar(f); e.target.value = ''; }} />
        </div>
        <Field label="群名">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} disabled={!canManage} />
        </Field>
        <Field label="群公告">
          <textarea value={notice} onChange={(e) => setNotice(e.target.value)} rows={4} maxLength={1000} disabled={!canManage} className={cx('resize-none py-2.5', inputClass)} placeholder="大家进群会看到" />
        </Field>
        {canManage && (
          <div className="flex items-center justify-between rounded-2xl bg-black/[0.03] px-4 py-3 dark:bg-white/5">
            <div>
              <div className="font-medium">入群审批</div>
              <div className="text-[0.82rem] text-ink-soft dark:text-white/50">开启后，普通成员拉人要管理员同意</div>
            </div>
            <Toggle label="入群审批" checked={conv.joinApproval} onChange={(on) => current().updateGroup(conv.id, { joinApproval: on }).catch(toastError)} />
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="danger" onClick={leave}><LogOut size={16} />{conv.myRole === 'owner' ? '解散群聊' : '退出群聊'}</Button>
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {canManage && <Button variant="primary" onClick={save} disabled={busy}>保存</Button>}
        </div>
      </div>
    </Dialog>
  );
}

/** Picks friends (checkbox list). */
export function FriendPicker({ friends, exclude, selected, onChange }: {
  friends: User[]; exclude?: Set<string>; selected: Set<string>; onChange: (s: Set<string>) => void;
}) {
  const list = friends.filter((f) => !exclude?.has(f.id));
  if (!list.length) return <p className="py-6 text-center text-ink-soft dark:text-white/50">没有可以选的好友</p>;
  return (
    <div className="max-h-72 space-y-1 overflow-y-auto">
      {list.map((f) => {
        const on = selected.has(f.id);
        return (
          <button
            key={f.id}
            onClick={() => {
              const n = new Set(selected);
              if (on) n.delete(f.id);
              else n.add(f.id);
              onChange(n);
            }}
            className={cx('lift flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left', on ? 'bg-accent-100 dark:bg-accent/15' : 'hover:bg-black/[0.03] dark:hover:bg-white/5')}
          >
            <UserAvatar user={f} size={34} />
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <IdentityChip user={f} short />
            <span className={cx('flex h-5 w-5 items-center justify-center rounded-md border-2 transition-colors', on ? 'border-accent bg-accent text-white' : 'border-black/20 dark:border-white/25')}>
              {on && <Check size={13} strokeWidth={3} />}
            </span>
          </button>
        );
      })}
    </div>
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
      toast(r.requested.length ? `已提交入群申请，等管理员同意` : `已邀请 ${r.added.length} 人`);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`邀请好友加入「${conv.name}」`}>
      <FriendPicker friends={v.friends} exclude={new Set(conv.members.map((m) => m.userId))} selected={sel} onChange={setSel} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={!sel.size} onClick={go}>邀请{sel.size ? ` ${sel.size} 人` : ''}</Button>
      </div>
    </Dialog>
  );
}
