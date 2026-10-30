// 账号设置: profile editing (name, avatar, signature), invites, devices,
// login records and logging out. The profile page itself is Profile.tsx.
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { motion } from 'motion/react';
import { Check, Copy, Download, ImageUp, KeyRound, LogOut, Monitor, Pencil, Plus, RefreshCw, Ticket } from 'lucide-react';
import { current, useApp } from '@/lib/store';
import { forgetLogin, useIdentity } from '@/lib/identity';
import { usePrefs } from '@/lib/prefs';
import { syncNow, useSync } from '@/lib/sync';
import { createPairing, type PairingCode } from '@/lib/devices';
import { errorText } from '@/lib/errors';
import type { SessionView } from '@/lib/session';
import type { Invite } from '@/lib/types';
import type { DeviceSession, LoginRecord } from '@/gen/am/v1/api_pb';
import { copyText } from '@/lib/platform';
import { chatTime } from '@/lib/format';
import { Button, Dialog, Input, Segmented, Spinner, Toggle, ask, cx, inputClass, spring, toast, toastError } from '@/ui';
import { UserAvatar } from './media';

type Tab = 'invites' | 'devices' | 'logins';

/** Longest signature the server accepts. */
const BIO_MAX = 100;

export function AccountPage({ v }: { v: SessionView }) {
  const [tab, setTab] = useState<Tab>('invites');
  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <h1 className="mb-6 text-[1.35rem] font-bold">账号设置</h1>
      <Profile v={v} />
      <Bio v={v} />
      <SyncCard v={v} />
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
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const saveName = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (name.trim() && name.trim() !== v.me?.name) await current().updateProfile({ displayName: name.trim() });
      setEditing(false);
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  const avatar = async (f: File) => {
    setUploading(true);
    try {
      const info = await current().upload(f);
      await current().updateProfile({ avatarMediaId: info.id });
      toast('头像已更新');
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="flex items-center gap-5">
      <button onClick={() => fileRef.current?.click()} disabled={uploading} aria-busy={uploading || undefined} className="press group relative rounded-full" aria-label="更换头像">
        <UserAvatar user={v.me} size={84} animated />
        {uploading && <span className="absolute inset-0 z-10 flex items-center justify-center rounded-full bg-black/45 text-white"><Spinner size={24} /></span>}
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          <ImageUp size={22} />
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) avatar(f); e.target.value = ''; }} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); saveName(); }} className="flex max-w-sm gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus disabled={saving} />
            <Button type="submit" variant="primary" loading={saving} aria-label="保存"><Check size={16} /></Button>
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
      </div>
      <Button
        variant="ghost"
        onClick={() => ask({ title: '退出登录？', text: `退出「${v.name}」的账号。之后可以用用户名和密码重新登录。`, ok: '退出', danger: true, run: () => current().logout() })}
      >
        <LogOut size={16} /> 退出登录
      </Button>
    </div>
  );
}

function Bio({ v }: { v: SessionView }) {
  const [bio, setBio] = useState(v.me?.bio ?? '');
  useEffect(() => setBio(v.me?.bio ?? ''), [v.me?.bio]);
  const changed = bio.trim() !== (v.me?.bio ?? '');
  return (
    <div className="mt-6 max-w-xl">
      <label htmlFor="bio" className="mb-1.5 block text-[0.85rem] font-medium text-ink-soft dark:text-white/60">个性签名</label>
      <textarea
        id="bio"
        value={bio}
        onChange={(e) => setBio(e.target.value)}
        maxLength={BIO_MAX}
        rows={2}
        placeholder="写点什么，会显示在你的个人主页上"
        className={cx(inputClass, 'resize-none py-2.5 leading-relaxed')}
      />
      <div className="mt-2 flex items-center gap-3">
        <span className="text-[0.8rem] text-ink-soft/80 dark:text-white/40">{[...bio].length} / {BIO_MAX}</span>
        <div className="flex-1" />
        {changed && <Button size="sm" variant="ghost" onClick={() => setBio(v.me?.bio ?? '')}>还原</Button>}
        <Button size="sm" variant="primary" disabled={!changed} onClick={() => current().updateProfile({ bio: bio.trim() }).then(() => toast('签名已保存'))}>保存签名</Button>
      </div>
    </div>
  );
}

const DELAYS = [
  { value: '10', label: '10 秒' }, { value: '30', label: '30 秒' }, { value: '120', label: '2 分钟' }, { value: '600', label: '10 分钟' },
];

/** 资料同步 (lib/sync.ts) and the login saved on this device (lib/identity.ts). */
function SyncCard({ v }: { v: SessionView }) {
  const prefs = usePrefs();
  const sync = useSync();
  const servers = useApp((s) => s.servers);
  const id = useIdentity();
  const waiting = Object.values(sync.pending).reduce((n, e) => n + Object.keys(e).length, 0);
  const errors = Object.entries(sync.errors).filter(([sid]) => servers.some((x) => x.id === sid));
  const nameOf = (sid: string) => servers.find((x) => x.id === sid)?.name ?? sid;
  return (
    <div className="mt-8 max-w-xl space-y-3">
      <div className="card rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <RefreshCw size={18} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">资料同步</div>
            <div className="text-[0.8rem] text-ink-soft dark:text-white/50">在一个服务器改了昵称、头像、签名、状态或主页，其他服务器也跟着改。聊天记录和频道不会同步。</div>
          </div>
          <Toggle checked={prefs.profileSync} onChange={(on) => prefs.set({ profileSync: on })} label="资料同步" />
        </div>
        {prefs.profileSync && (
          <div className="mt-3 space-y-3 border-t border-black/5 pt-3 dark:border-white/10">
            <div className="flex flex-wrap items-center gap-3 text-[0.85rem]">
              <span className="text-ink-soft dark:text-white/60">改完多久后同步</span>
              <Segmented id="sync-delay" value={String(prefs.syncDelay)} onChange={(d) => prefs.set({ syncDelay: Number(d) })} options={DELAYS} />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[0.82rem] text-ink-soft dark:text-white/50">
              <span className="flex-1">
                {servers.length < 2 ? '现在只有一个服务器，加入别的服务器后就会同步' : sync.running ? '正在同步…' : waiting ? `还有 ${waiting} 项等着同步（对方服务器连上就会同步）` : sync.last ? `都同步好了 · ${chatTime(sync.last)}` : '都同步好了'}
              </span>
              {servers.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => syncNow(v.id).then(() => toast(Object.keys(useSync.getState().errors).length ? '有的服务器没同步成功' : '已同步'))}>
                  把这里的资料同步到其他服务器
                </Button>
              )}
            </div>
            {errors.map(([sid, msg]) => (
              <p key={sid} className="text-[0.8rem] text-rose-500">「{nameOf(sid)}」：{msg}</p>
            ))}
          </div>
        )}
      </div>
      <div className="card flex items-center gap-3 rounded-2xl p-4">
        <KeyRound size={18} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">这台设备保存的登录</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">
            {id.username
              ? `用户名 ${id.username}${id.hasPassword ? '，密码保存在系统的凭据管理器里' : '（这台设备不能保存密码）'}。加入新服务器、重新登录时直接用。`
              : '还没有保存。下次登录或注册成功后会自动保存。'}
          </div>
        </div>
        {id.username && (
          <Button size="sm" variant="ghost" onClick={() => ask({ title: '忘记保存的登录？', text: '这台设备上保存的用户名和密码会删掉，已经登录的服务器不受影响。下次登录成功后会重新保存。', ok: '忘记', danger: true, run: forgetLogin })}>
            忘记
          </Button>
        )}
      </div>
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
  const [data, setData] = useState<{ list: DeviceSession[]; max: number } | null>(null);
  const [pairing, setPairing] = useState(false);
  const load = useCallback(() => current().sessions().then(setData).catch(toastError), []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="py-10 text-center text-ink-soft"><Spinner /></div>;
  const full = data.max > 0 && data.list.length >= data.max;
  return (
    <div className="max-w-2xl space-y-2">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-[0.85rem] text-ink-soft dark:text-white/55">
          {data.max > 0 ? `已登录 ${data.list.length} / ${data.max} 台设备。` : `已登录 ${data.list.length} 台设备。`}
          {full ? '满了，要先让一台下线才能添加新设备。' : '手机、电脑都算。'}
        </div>
        <Button variant="primary" size="sm" disabled={full} onClick={() => setPairing(true)}>
          <Plus size={15} /> 添加新设备
        </Button>
      </div>
      {data.list.map((d) => (
        <div key={String(d.id)} className="card flex items-center gap-3 rounded-2xl bg-white/95 p-4 dark:bg-white/[0.06]">
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
      <PairDialog open={pairing} before={data.list.length} onClose={() => { setPairing(false); load(); }} />
    </div>
  );
}

/**
 * "添加新设备": a one-time code (QR + text) that logs a new device in on all
 * my servers and brings my saved login and settings (lib/devices.ts).
 */
function PairDialog({ open, before, onClose }: { open: boolean; before: number; onClose: () => void }) {
  const v = useApp((s) => s.sessions[s.currentId ?? '']);
  const [p, setP] = useState<PairingCode | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [done, setDone] = useState(false);
  const make = useCallback(() => {
    setP(null);
    setError('');
    setDone(false);
    createPairing(useApp.getState().currentId ?? '').then(async (r) => {
      setP(r);
      setQr(await QRCode.toDataURL(r.url, { margin: 1, width: 420, color: { dark: '#2a2440', light: '#ffffff' } }));
    }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    if (open) make();
  }, [open, make]);
  // Countdown, and watch for the new device to show up.
  useEffect(() => {
    if (!open || !p || done) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    const w = setInterval(() => {
      current().sessions().then((r) => r.list.length > before && setDone(true)).catch(() => {});
    }, 3000);
    return () => {
      clearInterval(t);
      clearInterval(w);
    };
  }, [open, p, done, before]);
  const left = p ? Math.max(0, Math.round((p.expiresAt - now) / 1000)) : 0;
  return (
    <Dialog open={open} onClose={onClose} title="添加新设备" width={460}>
      {error ? (
        <div className="space-y-4">
          <p className="text-rose-500" role="alert">{error}</p>
          <Button className="w-full" onClick={make}>再试一次</Button>
        </div>
      ) : done ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15"><Check size={28} /></span>
          <div className="text-[1.1rem] font-semibold">新设备已登录</div>
          <p className="text-[0.85rem] text-ink-soft dark:text-white/55">不是你自己的话，马上在列表里让它下线，再找管理员重置密码。</p>
          <Button variant="primary" onClick={onClose}>好的</Button>
        </div>
      ) : !p ? (
        <div className="flex justify-center py-12 text-ink-soft"><Spinner /></div>
      ) : (
        <div className="space-y-3">
          <p className="text-[0.85rem] text-ink-soft dark:text-white/60">
            在新设备上打开 AM，点「从已有设备登录」，扫这个二维码或者粘贴下面的登录码。所有服务器会一起登录，保存的密码和个性化设置也会带过去。
          </p>
          <div className={cx('mx-auto aspect-square w-56 overflow-hidden rounded-2xl bg-white p-2 shadow-[var(--shadow-card)]', left === 0 && 'opacity-30')}>
            {qr && <img src={qr} alt="登录二维码" className="h-full w-full" />}
          </div>
          <div className="selectable rounded-xl bg-black/[0.04] p-2.5 text-center font-mono text-[0.78rem] break-all dark:bg-white/5">{p.code}</div>
          <div className="flex items-center gap-2">
            <span className={cx('flex-1 text-[0.82rem]', left < 60 ? 'text-rose-500' : 'text-ink-soft dark:text-white/50')}>
              {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 内有效，只能用一次` : '已过期'}
            </span>
            {left > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => copyText(p.code).then(() => toast('已复制登录码'))}><Copy size={14} /> 复制</Button>
            ) : (
              <Button size="sm" variant="primary" onClick={make}>重新生成</Button>
            )}
          </div>
          {p.skipped.length > 0 && (
            <div className="rounded-xl bg-amber-50 p-2.5 text-[0.8rem] text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
              这些服务器新设备要用密码登录：{p.skipped.join('；')}
            </div>
          )}
          {p.noBackground && <p className="text-[0.8rem] text-ink-soft dark:text-white/50">背景图片太大，没有带过去，在新设备上重新选一下。</p>}
          <p className="text-[0.75rem] text-ink-soft/80 dark:text-white/40">登录码就等于你的账号，别发给别人。{v ? `生成在「${v.name}」上。` : ''}</p>
        </div>
      )}
    </Dialog>
  );
}

const LOGIN_KIND: Record<string, string> = { register: '注册', login: '登录', rejoin: '回来', pair: '配对' };

function Logins() {
  const [list, setList] = useState<LoginRecord[] | null>(null);
  useEffect(() => {
    current().logins().then(setList).catch(toastError);
  }, []);
  if (!list) return <div className="py-10 text-center text-ink-soft"><Spinner /></div>;
  return (
    <div className="max-w-2xl overflow-hidden rounded-2xl bg-white/95 shadow-[var(--shadow-card)] dark:bg-white/[0.05]">
      {list.map((r, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-black/5 px-4 py-3 text-[0.9rem] last:border-0 dark:border-white/5">
          <span className="w-36 shrink-0 text-ink-soft dark:text-white/55">{chatTime(Number(r.createdAt))}</span>
          <span className="w-12 shrink-0">{LOGIN_KIND[r.kind] ?? '登录'}</span>
          <span className="selectable font-mono text-[0.85rem]">{r.ip}</span>
          <span className="ml-auto truncate text-ink-soft dark:text-white/50">{r.deviceName}</span>
        </div>
      ))}
    </div>
  );
}
