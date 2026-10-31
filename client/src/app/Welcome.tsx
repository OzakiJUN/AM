import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ClipboardPaste, ImageUp, KeyRound, LayoutDashboard, MonitorSmartphone, Sparkles, X } from 'lucide-react';
import { findJoinCode, parseJoinCode, type Join } from '@/lib/joincode';
import { findPairCode } from '@/lib/paircode';
import { redeemPairing } from '@/lib/devices';
import { readClipboardText, scanQRFromFile } from '@/lib/platform';
import { addServer, removeServer, switchServer, useApp } from '@/lib/store';
import { endpointFromJoin, fetchServerInfo } from '@/lib/transport';
import { errorText } from '@/lib/errors';
import { rememberLogin, savedPassword, useIdentity } from '@/lib/identity';
import { copyAll, forgetServer, profileSource, whenReady } from '@/lib/sync';
import type { User } from '@/lib/types';
import { Avatar, Button, Field, Input, Toggle, ask, cx, inputClass, spring, toast } from '@/ui';
import { useMediaUrl } from './media';
import logo from '@/assets/logo.png';

interface Found {
  join: Join;
  name: string;
}

type Step = { kind: 'start' } | { kind: 'register'; found: Found } | { kind: 'login'; found: Found } | { kind: 'pair'; code: string };

/** Joins a server with a join code, then registers or logs in. */
export function Welcome() {
  const hasServers = useApp((s) => s.servers.some((x) => x.token));
  const [step, setStep] = useState<Step>({ kind: 'start' });
  return (
    <div className="flex h-full items-center justify-center p-6">
      <motion.div layout transition={spring} className="glass-strong relative w-full max-w-[440px] overflow-hidden rounded-3xl p-8 shadow-2xl">
        {hasServers && step.kind === 'start' && (
          <button
            onClick={() => useApp.setState({ view: 'main' })}
            aria-label="关闭"
            className="press absolute top-4 right-4 rounded-xl p-2 text-ink-soft hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
          >
            <X size={18} />
          </button>
        )}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step.kind}
            initial={{ opacity: 0, x: step.kind === 'start' ? -24 : 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: step.kind === 'start' ? 24 : -24 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            {step.kind === 'start' && (
              <>
                <Start onFound={(found) => setStep({ kind: found.join.invite ? 'register' : 'login', found })} onPair={(code) => setStep({ kind: 'pair', code })} />
                <button
                  onClick={() => useApp.setState({ view: 'main' })}
                  className="press mx-auto mt-3 flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[0.85rem] text-accent-700 hover:bg-accent-50 dark:text-accent-200 dark:hover:bg-white/5"
                >
                  <LayoutDashboard size={15} /> 先不加入，进入主界面
                </button>
              </>
            )}
            {step.kind === 'pair' && <PairLogin initial={step.code} onBack={() => setStep({ kind: 'start' })} />}
            {step.kind === 'register' && (
              <Account mode="register" found={step.found} onBack={() => setStep({ kind: 'start' })} onSwitch={() => setStep({ kind: 'login', found: step.found })} />
            )}
            {step.kind === 'login' && (
              <Account mode="login" found={step.found} onBack={() => setStep({ kind: 'start' })} onSwitch={step.found.join.invite ? () => setStep({ kind: 'register', found: step.found }) : undefined} />
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

async function resolve(code: string): Promise<Found> {
  const join = await parseJoinCode(code);
  const r = await fetchServerInfo(endpointFromJoin(join));
  if (r.status !== 200) throw new Error(`服务器返回 ${r.status}`);
  const info = JSON.parse(r.body) as { name?: string };
  return { join, name: info.name || join.address };
}

function Start({ onFound, onPair }: { onFound: (f: Found) => void; onPair: (code: string) => void }) {
  const [detected, setDetected] = useState<Found | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A join code in the clipboard (copied from a chat) is offered right away.
  useEffect(() => {
    let alive = true;
    readClipboardText().then(async (clip) => {
      const pc = clip && findPairCode(clip);
      if (pc) return alive && setPairCode(pc);
      const code = clip && findJoinCode(clip);
      if (!code) return;
      try {
        const f = await resolve(code);
        if (alive) setDetected(f);
      } catch {
        /* unusable or unreachable: stay quiet, the user can paste */
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  async function use(code: string) {
    setError('');
    const pc = findPairCode(code);
    if (pc) return onPair(pc);
    setBusy(true);
    try {
      onFound(await resolve(code));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function fromImage(file: Blob) {
    const content = await scanQRFromFile(file).catch(() => null);
    const code = content && (findPairCode(content) ?? findJoinCode(content));
    if (!code) {
      setError('图片里没有找到加入码二维码');
      return;
    }
    setText(code);
    use(code);
  }

  return (
    <>
      <div className="mb-7 flex flex-col items-center text-center">
        <motion.img
          src={logo}
          alt=""
          className="mb-4 h-16 w-16 drop-shadow-[0_10px_20px_rgba(36,67,143,0.25)]"
          initial={{ scale: 0.6, rotate: -8, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 16 }}
        />
        <h1 className="text-[1.6rem] font-bold tracking-tight">欢迎来到 AM</h1>
        <p className="mt-1.5 text-ink-soft dark:text-white/60">粘贴朋友发给你的加入码，或者识别二维码</p>
      </div>

      <AnimatePresence>
        {pairCode && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 20 }}
            transition={spring}
            className="overflow-hidden rounded-2xl bg-gradient-to-br from-accent to-violet-500 p-[1.5px]"
          >
            <div className="flex items-center gap-3 rounded-[15px] bg-white/92 p-4 dark:bg-[#221f3c]/92">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-100 text-accent dark:bg-accent/20">
                <MonitorSmartphone size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[0.8rem] text-ink-soft dark:text-white/50">在剪贴板里发现了登录码</div>
                <div className="truncate font-semibold">用你另一台设备的账号登录</div>
              </div>
              <Button variant="primary" size="sm" onClick={() => onPair(pairCode)}>登录</Button>
            </div>
          </motion.div>
        )}
        {detected && !pairCode && (
          <motion.div
            initial={{ opacity: 0, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, height: 'auto', marginBottom: 20 }}
            transition={spring}
            className="overflow-hidden rounded-2xl bg-gradient-to-br from-accent to-violet-500 p-[1.5px]"
          >
            <div className="flex items-center gap-3 rounded-[15px] bg-white/92 p-4 dark:bg-[#221f3c]/92">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-100 text-accent dark:bg-accent/20">
                <Sparkles size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[0.8rem] text-ink-soft dark:text-white/50">在剪贴板里发现了{detected.join.invite ? '加入码' : '服务器码'}</div>
                <div className="truncate font-semibold">「{detected.name}」{detected.join.invite ? '邀请你加入' : ''}</div>
              </div>
              <Button variant="primary" size="sm" onClick={() => onFound(detected)}>{detected.join.invite ? '加入' : '登录'}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) use(text);
        }}
      >
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const img = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile();
              if (img) {
                e.preventDefault();
                fromImage(img);
              }
            }}
            placeholder="AM1-XXXX-XXXX-…（也可以直接粘贴二维码截图）"
            rows={3}
            spellCheck={false}
            aria-label="加入码"
            className={cx('resize-none py-3 font-mono text-[0.9rem]', inputClass)}
          />
          <button
            type="button"
            onClick={async () => setText((await readClipboardText()) ?? '')}
            className="press absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[0.8rem] text-accent-700 hover:bg-accent-100 dark:text-accent-200 dark:hover:bg-white/10"
          >
            <ClipboardPaste size={14} /> 粘贴
          </button>
        </div>
        <AnimatePresence>
          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[0.85rem] text-rose-500" role="alert">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!text.trim()}>
          下一步
        </Button>
      </form>

      <div className="mt-3 flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={() => fileRef.current?.click()}>
          <ImageUp size={17} /> 选一张二维码图片
        </Button>
        <Button variant="ghost" className="flex-1" onClick={() => onPair('')}>
          <MonitorSmartphone size={17} /> 从已有设备登录
        </Button>
      </div>
      <p className="mt-4 text-center text-[0.8rem] text-ink-soft/80 dark:text-white/40">已经有账号？向服主要一个服务器码，粘贴到上面就能登录</p>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && fromImage(e.target.files[0])} />
    </>
  );
}

function Account({ mode, found, onBack, onSwitch }: { mode: 'register' | 'login'; found: Found; onBack: () => void; onSwitch?: () => void }) {
  const saved = useIdentity();
  const [source] = useState(profileSource); // where "my profile" is copied from
  const [username, setUsername] = useState(saved.username);
  const [display, setDisplay] = useState('');
  const [password, setPassword] = useState('');
  const [savedPw, setSavedPw] = useState<string | null>(null);
  const [mine, setMine] = useState(true); // use my saved login + profile
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const me = source?.view.me;
  const useSaved = mine && savedPw !== null;
  const copy = mine && !!me;

  useEffect(() => {
    let alive = true;
    savedPassword().then((p) => alive && setSavedPw(p));
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const ep = endpointFromJoin(found.join);
    const old = useApp.getState().servers.find((x) => x.endpoint.address === ep.address);
    if (old && (old.endpoint.pin !== ep.pin || old.endpoint.plain !== ep.plain)) {
      const ok = await ask({
        title: '替换这个服务器？',
        text: `这个地址以前是「${old.name}」，现在的证书不一样了（多半是服务器重装过）。继续的话，这台设备上的「${old.name}」会换成「${found.name}」，旧的登录就不用了。`,
        ok: '替换',
        danger: true,
      });
      if (ok === null) return;
      forgetServer(old.id);
    }
    setBusy(true);
    const pw = useSaved ? savedPw : password;
    const user = username.trim();
    const s = addServer({ endpoint: ep, name: found.name });
    // Already logged in there (also when the server only moved to a new address): just open it.
    if (s.record.token) {
      setBusy(false);
      switchServer(s.record.id);
      useApp.setState({ page: 'channels' });
      toast(`已经加过「${found.name}」了${old ? '' : '，地址已更新'}`);
      return;
    }
    try {
      if (mode === 'register') await s.register(found.join.invite!, user, pw, (copy ? me.name : display.trim()) || user);
      // A join code with an invite also brings back an account that left the server.
      else await s.login(user, pw, found.join.invite ?? '');
      void rememberLogin(user, pw);
      // (Not when the server being replaced was the source itself.)
      if (copy && source!.record.id !== old?.id) {
        const from = source!.record.id;
        const to = s.record.id;
        whenReady(to).then(() => copyAll(from, to)).then(
          () => toast(`已把你的资料复制到「${s.view.name}」`),
          (err) => toast(`复制资料没成功：${errorText(err)}（可以在账号设置里再同步）`, true),
        );
      }
      switchServer(s.record.id);
      useApp.setState({ page: 'channels' }); // land in the server's channels
    } catch (err) {
      setError(errorText(err));
      // Don't keep a server we never got into.
      if (!old && !s.record.token) removeServer(s.record.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        <button onClick={onBack} aria-label="返回" className="press rounded-xl p-2 text-ink-soft hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10">
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0">
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">{mode === 'register' ? '注册' : '登录'}</div>
          <div className="truncate text-[1.15rem] font-semibold">{found.name}</div>
        </div>
      </div>
      <form className="space-y-4" onSubmit={submit}>
        {mode === 'register' && (
          <div className="flex items-center justify-between rounded-2xl bg-accent-50 px-4 py-3 text-[0.9rem] dark:bg-white/5">
            <span className="text-ink-soft dark:text-white/60">邀请码</span>
            <span className="font-mono font-semibold tracking-wider text-accent-700 dark:text-accent-200">{found.join.invite?.replace(/(.{4})(?=.)/g, '$1 ')} ✓</span>
          </div>
        )}
        {(me || savedPw !== null) && (
          <div className={cx('rounded-2xl p-3 transition-colors', mine ? 'bg-accent-50 dark:bg-accent/10' : 'bg-black/[0.03] dark:bg-white/[0.04]')}>
            <div className="flex items-center gap-3">
              {me && <SourceAvatar user={me} serverId={source!.record.id} />}
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{me ? `用我的资料：${me.name}` : '用保存的账号'}</div>
                <div className="text-[0.78rem] text-ink-soft dark:text-white/50">
                  {me ? `昵称、头像、签名和主页从「${source!.view.name}」复制过来，以后改了也会同步` : '用户名和密码都填好了'}
                </div>
              </div>
              <Toggle checked={mine} onChange={setMine} label="用我的资料" />
            </div>
          </div>
        )}
        <Field label="用户名" hint={mode === 'register' ? '3–20 位字母、数字或下划线，用来登录，以后不能改' : undefined}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={mode === 'register' ? '例如 weiqi' : ''} autoComplete="username" autoFocus={!username} required />
        </Field>
        {mode === 'register' && !copy && (
          <Field label="昵称" hint="大家看到的名字，随时能改">
            <Input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="不填就用用户名" maxLength={32} />
          </Field>
        )}
        {useSaved ? (
          <div className="flex items-center gap-2 rounded-2xl bg-black/[0.03] px-4 py-3 text-[0.9rem] dark:bg-white/[0.04]">
            <KeyRound size={16} className="text-accent" />
            <span className="flex-1">密码用这台设备保存的</span>
            <button type="button" onClick={() => setSavedPw(null)} className="text-[0.85rem] text-accent-700 hover:underline dark:text-accent-200">换一个</button>
          </div>
        ) : (
          <Field label="密码" hint={mode === 'register' ? '至少 8 位' : undefined}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} autoFocus={!!username} required />
          </Field>
        )}
        <AnimatePresence>
          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[0.85rem] text-rose-500" role="alert">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {mode === 'register' ? '注册并进入' : '登录'}
        </Button>
        {onSwitch && (
          <button type="button" onClick={onSwitch} className="w-full text-center text-[0.85rem] text-accent-700 hover:underline dark:text-accent-200">
            {mode === 'register' ? '我已经有这个服务器的账号，直接登录' : '还没有账号，用邀请码注册'}
          </button>
        )}
        {mode === 'login' && found.join.invite && (
          <p className="text-center text-[0.8rem] text-ink-soft/80 dark:text-white/40">以前退出过这个服务器？用这个带邀请码的加入码登录就能回来。</p>
        )}
      </form>
    </>
  );
}

function SourceAvatar({ user, serverId }: { user: User; serverId: string }) {
  const src = useMediaUrl(user.avatarStatic, serverId);
  return <Avatar src={src} name={user.name} size={40} />;
}

/** "从已有设备登录": a pairing code made on my other device (lib/devices.ts). */
function PairLogin({ initial, onBack }: { initial: string; onBack: () => void }) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function go(code: string) {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const later = await redeemPairing(code);
      useApp.setState({ page: 'channels' });
      toast(later.length ? `已登录。这些服务器要输一次密码：${later.join('、')}` : '已登录你所有的服务器', later.length > 0);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function fromImage(file: Blob) {
    const content = await scanQRFromFile(file).catch(() => null);
    const code = content && findPairCode(content);
    if (!code) return setError('图片里没有找到登录码二维码');
    setText(code);
    go(code);
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <button onClick={onBack} aria-label="返回" className="press rounded-xl p-2 text-ink-soft hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10">
          <ArrowLeft size={20} />
        </button>
        <div className="text-[1.15rem] font-semibold">从已有设备登录</div>
      </div>
      <p className="mb-4 text-[0.88rem] text-ink-soft dark:text-white/60">
        在已经登录的设备上打开 账号设置 → 登录设备 → 添加新设备，把登录码粘贴到这里，或者扫二维码。你的所有服务器、保存的密码和个性化设置会一起过来。
      </p>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) go(text); }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const img = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))?.getAsFile();
            if (img) {
              e.preventDefault();
              fromImage(img);
            }
          }}
          placeholder="AMP-XXXX-XXXX-…（也可以直接粘贴二维码截图）"
          rows={4}
          spellCheck={false}
          aria-label="登录码"
          className={cx('resize-none py-3 font-mono text-[0.85rem]', inputClass)}
        />
        {error && <p className="text-[0.85rem] text-rose-500" role="alert">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!text.trim()}>登录</Button>
      </form>
      <Button variant="ghost" className="mt-3 w-full" onClick={() => fileRef.current?.click()}>
        <ImageUp size={17} /> 选一张二维码图片
      </Button>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && fromImage(e.target.files[0])} />
    </>
  );
}
