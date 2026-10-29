import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { motion } from 'motion/react';
import { Check, Copy, Download, ImageUp, LogOut, Monitor, Pencil, Plus, Ticket } from 'lucide-react';
import { current } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Invite } from '@/lib/types';
import type { DeviceSession, LoginRecord } from '@/gen/am/v1/api_pb';
import { copyText } from '@/lib/platform';
import { chatTime } from '@/lib/format';
import { Button, Input, Segmented, Spinner, ask, cx, spring, toast, toastError } from '@/ui';
import { UserAvatar } from './media';

type Tab = 'invites' | 'devices' | 'logins';

export function MePage({ v }: { v: SessionView }) {
  const [tab, setTab] = useState<Tab>('invites');
  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <Profile v={v} />
      <div className="mt-10 mb-5 flex items-center gap-3">
        <Segmented id="me" value={tab} onChange={setTab} options={[
          { value: 'invites', label: '我的邀请' }, { value: 'devices', label: '登录设备' }, { value: 'logins', label: '登录记录' },
        ]} />
      </div>
      <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
        {tab === 'invites' && <Invites />}
        {tab === 'devices' && <Devices />}
        {tab === 'logins' && <Logins />}
      </motion.div>
    </section>
  );
}

function Profile({ v }: { v: SessionView }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(v.me?.name ?? '');
  const fileRef = useRef<HTMLInputElement>(null);
  const saveName = async () => {
    try {
      if (name.trim() && name.trim() !== v.me?.name) await current().updateProfile({ displayName: name.trim() });
      setEditing(false);
    } catch (e) {
      toastError(e);
    }
  };
  const avatar = async (f: File) => {
    try {
      const info = await current().upload(f);
      await current().updateProfile({ avatarMediaId: info.id });
      toast('头像已更新');
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex items-center gap-5">
      <button onClick={() => fileRef.current?.click()} className="press group relative rounded-full" aria-label="更换头像">
        <UserAvatar user={v.me} size={84} animated />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <ImageUp size={22} />
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) avatar(f); e.target.value = ''; }} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="flex max-w-sm gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus />
            <Button type="submit" variant="primary"><Check size={16} /></Button>
          </form>
        ) : (
          <h2 className="flex items-center gap-2 text-[1.6rem] font-bold">
            {v.me?.name}
            <button onClick={() => { setName(v.me?.name ?? ''); setEditing(true); }} className="press rounded-lg p-1.5 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10" aria-label="改昵称">
              <Pencil size={16} />
            </button>
          </h2>
        )}
        <div className="text-ink-soft dark:text-white/55">@{v.me?.username} · {v.name}</div>
        <div className="mt-1 text-[0.8rem] text-ink-soft/80 dark:text-white/40">头像支持 GIF 动图，列表里显示第一帧</div>
      </div>
      <Button
        variant="ghost"
        onClick={async () => (await ask({ title: '退出登录？', text: `退出「${v.name}」的账号。之后可以用用户名和密码重新登录。`, ok: '退出', danger: true })) !== null && current().logout()}
      >
        <LogOut size={16} /> 退出登录
      </Button>
    </div>
  );
}

function Invites() {
  const [data, setData] = useState<{ list: Invite[]; remaining: number } | null>(null);
  const load = useCallback(() => current().invites().then(setData).catch(toastError), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="py-10 text-center text-ink-soft"><Spinner /></div>;
  const left = data.list.filter((i) => !i.usedBy).length;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-[1.15rem] font-semibold"><Ticket size={20} className="text-accent" /> 我的邀请</h3>
          <p className="mt-1 text-ink-soft dark:text-white/55">把加入码或二维码发给朋友：他们复制加入码后打开 AM 就能直接注册。还剩 {left} 个，每个只能用一次。</p>
        </div>
        {data.remaining < 0 && (
          <Button variant="soft" onClick={() => current().createInvite().then(load).catch(toastError)}><Plus size={16} /> 再要一个（管理员）</Button>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
        {data.list.map((inv, i) => (
          <motion.div key={inv.code} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.04 }}>
            <InviteCard inv={inv} />
          </motion.div>
        ))}
      </div>
    </>
  );
}

function InviteCard({ inv }: { inv: Invite }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (inv.joinUrl) QRCode.toDataURL(inv.joinUrl, { margin: 1, width: 420, color: { dark: '#2a2440', light: '#ffffff' } }).then(setQr);
  }, [inv.joinUrl]);
  const used = !!inv.usedBy;
  return (
    <div className={cx('card rounded-3xl bg-white/85 p-4 dark:bg-white/[0.06]', used && 'opacity-60')}>
      <div className="relative mx-auto aspect-square w-full max-w-[200px] overflow-hidden rounded-2xl bg-white p-2">
        {qr && !used && <img src={qr} alt="邀请二维码" className="h-full w-full" />}
        {used && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/[0.03]">
            <span className="rounded-full bg-black/70 px-3 py-1 text-[0.85rem] text-white">{inv.usedBy} 已加入</span>
          </div>
        )}
      </div>
      <div className="selectable mt-3 truncate text-center font-mono text-[0.75rem] text-ink-soft dark:text-white/50" title={inv.joinCode}>
        {used ? inv.code : inv.joinCode}
      </div>
      {!used && (
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              copyText(inv.joinCode);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <><Check size={15} /> 已复制</> : <><Copy size={15} /> 复制加入码</>}
          </Button>
          <Button
            variant="soft"
            size="sm"
            aria-label="保存二维码"
            title="保存二维码"
            onClick={() => {
              const a = document.createElement('a');
              a.href = qr;
              a.download = `AM-邀请-${inv.code}.png`;
              a.click();
            }}
          >
            <Download size={15} />
          </Button>
        </div>
      )}
    </div>
  );
}

function Devices() {
  const [list, setList] = useState<DeviceSession[] | null>(null);
  const load = useCallback(() => current().sessions().then(setList).catch(toastError), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return <div className="py-10 text-center text-ink-soft"><Spinner /></div>;
  return (
    <div className="max-w-2xl space-y-2">
      {list.map((d) => (
        <div key={String(d.id)} className="card flex items-center gap-3 rounded-2xl bg-white/80 p-4 dark:bg-white/[0.06]">
          <Monitor size={20} className="text-ink-soft" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{d.deviceName || '未知设备'} {d.current && <span className="ml-1 rounded-md bg-emerald-100 px-1.5 text-[0.75rem] text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">本机</span>}</div>
            <div className="text-[0.82rem] text-ink-soft dark:text-white/50">最近活动 {chatTime(Number(d.lastSeen))} · 登录于 {chatTime(Number(d.createdAt))}</div>
          </div>
          {!d.current && (
            <Button size="sm" variant="danger" onClick={() => current().revokeSession(d.id).then(load).catch(toastError)}>下线</Button>
          )}
        </div>
      ))}
    </div>
  );
}

function Logins() {
  const [list, setList] = useState<LoginRecord[] | null>(null);
  useEffect(() => {
    current().logins().then(setList).catch(toastError);
  }, []);
  if (!list) return <div className="py-10 text-center text-ink-soft"><Spinner /></div>;
  return (
    <div className="max-w-2xl overflow-hidden rounded-2xl bg-white/70 shadow-[var(--shadow-card)] dark:bg-white/[0.05]">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-black/5 px-4 py-3 text-[0.9rem] last:border-0 dark:border-white/5">
          <span className="w-36 shrink-0 text-ink-soft dark:text-white/55">{chatTime(Number(r.createdAt))}</span>
          <span className="w-12 shrink-0">{r.kind === 'register' ? '注册' : '登录'}</span>
          <span className="selectable font-mono text-[0.85rem]">{r.ip}</span>
          <span className="ml-auto truncate text-ink-soft dark:text-white/50">{r.deviceName}</span>
        </div>
      ))}
    </div>
  );
}
