import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ClipboardPaste, ImageUp, Sparkles, X } from 'lucide-react';
import { findJoinCode, parseJoinCode, type Join } from '@/lib/joincode';
import { readClipboardText, scanQRFromFile } from '@/lib/platform';
import { addServer, removeServer, switchServer, useApp } from '@/lib/store';
import { endpointFromJoin, fetchServerInfo } from '@/lib/transport';
import { errorText } from '@/lib/errors';
import { Button, Field, Input, cx, inputClass, spring } from '@/ui';
import logo from '@/assets/logo.png';

interface Found {
  join: Join;
  name: string;
}

type Step = { kind: 'start' } | { kind: 'register'; found: Found } | { kind: 'login'; found: Found };

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
            {step.kind === 'start' && <Start onFound={(found) => setStep({ kind: found.join.invite ? 'register' : 'login', found })} />}
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

function Start({ onFound }: { onFound: (f: Found) => void }) {
  const [detected, setDetected] = useState<Found | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A join code in the clipboard (copied from a chat) is offered right away.
  useEffect(() => {
    let alive = true;
    readClipboardText().then(async (clip) => {
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
    const code = content && findJoinCode(content);
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
        {detected && (
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

      <Button variant="ghost" className="mt-3 w-full" onClick={() => fileRef.current?.click()}>
        <ImageUp size={17} /> 选一张二维码图片
      </Button>
      <p className="mt-4 text-center text-[0.8rem] text-ink-soft/80 dark:text-white/40">已经有账号？向服主要一个服务器码，粘贴到上面就能登录</p>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && fromImage(e.target.files[0])} />
    </>
  );
}

function Account({ mode, found, onBack, onSwitch }: { mode: 'register' | 'login'; found: Found; onBack: () => void; onSwitch?: () => void }) {
  const [username, setUsername] = useState('');
  const [display, setDisplay] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    const ep = endpointFromJoin(found.join);
    const existed = useApp.getState().servers.some((x) => x.endpoint.address === ep.address);
    const s = addServer({ endpoint: ep, name: found.name });
    try {
      if (mode === 'register') await s.register(found.join.invite!, username.trim(), password, display.trim());
      else await s.login(username.trim(), password);
      switchServer(s.record.id);
    } catch (err) {
      setError(errorText(err));
      // Don't keep a server we never got into.
      if (!existed && !s.record.token) removeServer(s.record.id);
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
        <Field label="用户名" hint={mode === 'register' ? '3–20 位字母、数字或下划线，用来登录，以后不能改' : undefined}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={mode === 'register' ? '例如 weiqi' : ''} autoComplete="username" autoFocus required />
        </Field>
        {mode === 'register' && (
          <Field label="昵称" hint="大家看到的名字，随时能改">
            <Input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="不填就用用户名" maxLength={32} />
          </Field>
        )}
        <Field label="密码" hint={mode === 'register' ? '至少 8 位' : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required />
        </Field>
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
      </form>
    </>
  );
}
