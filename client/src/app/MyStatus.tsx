// 我的状态 in 账号设置: invisible mode and "正在..." activity (saved on the
// server; copied to my other servers by lib/sync.ts).
import { useEffect, useState } from 'react';
import { EyeOff, X } from 'lucide-react';
import { ACTIVITIES, ACTIVITY_MAX, presenceText } from '@/lib/presence';
import { current } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { ActivityKind } from '@/lib/types';
import { Button, Toggle, cx, inputClass } from '@/ui';

/** Invisible mode and "正在..." activity. */
export function MyStatus({ v }: { v: SessionView }) {
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
    <div className="card mt-8 max-w-xl rounded-3xl bg-white/90 p-6 dark:bg-white/[0.06]">
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
