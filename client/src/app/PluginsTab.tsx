// The 插件 tab of an AI's settings (docs/plugins.md): upload NoneBot plugins
// (zip), see whether the server's admin approved them, turn them on / off,
// change their settings in a form generated from what the server read out
// of the plugin, and read the plugin process's log. Plugins run on the
// server, as this AI.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, FileArchive, Plug, RefreshCw, ScrollText, Settings2, Trash2 } from 'lucide-react';
import type { Plugin, PluginList, PluginSetting } from '@/lib/session';
import { fromText, groupSettings, settingLabel, toText } from '@/lib/plugins';
import { refreshPluginCommands } from '@/lib/ai/runner';
import { session, useApp } from '@/lib/store';
import { Button, Empty, Input, Spinner, Toggle, ask, cx, inputClass, toast, toastError } from '@/ui';

const STATE: Record<string, string> = {
  off: '没有在运行', preparing: '正在安装插件要用的 Python 包…', starting: '正在启动…', running: '运行中', error: '出错了',
};
const STATUS: Record<Plugin['status'], [string, string]> = {
  pending: ['等管理员审核', 'bg-amber-500/15 text-amber-700 dark:text-amber-300'],
  approved: ['已批准', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'],
  rejected: ['没通过', 'bg-rose-500/15 text-rose-600 dark:text-rose-300'],
};

export function PluginsTab({ aiId, aiName }: { aiId: string; aiName: string }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const s = session(serverId);
  const [list, setList] = useState<PluginList | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => s?.listPlugins(aiId).then(setList).catch(toastError);
  useEffect(() => {
    void load();
    // The process starts / installs in the background: keep the state fresh while the tab is open.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [serverId, aiId]);

  if (!s?.view.plugins) {
    return <Empty icon={<Plug size={22} />} title="这个服务器没开插件" text="插件在服务器上运行，要服务器的管理员在 config.toml 里打开（[plugins] enabled）。" />;
  }
  if (!list) return <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>;

  const changed = (p: Plugin) => {
    setList((l) => l && { ...l, plugins: l.plugins.map((x) => (x.id === p.id ? p : x)) });
    refreshPluginCommands(serverId, aiId);
  };

  async function upload(f: File) {
    setUploading(true);
    try {
      const got = await s!.uploadPlugins(aiId, f);
      const waiting = got.filter((p) => p.status === 'pending').length;
      toast(waiting ? `传好了 ${got.length} 个插件，${waiting} 个要等服务器管理员看过代码、批准后才会运行` : `传好了 ${got.length} 个插件`);
      await load();
      refreshPluginCommands(serverId, aiId);
      if (got.length === 1) setOpen(got[0].id);
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const running = list.plugins.some((p) => p.status === 'approved' && p.enabled);
  return (
    <>
      <div className="card flex items-start gap-3 rounded-2xl p-4">
        <Plug size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 text-[0.85rem]">
          <div className="font-semibold">NoneBot 插件（OneBot v11）</div>
          <div className="mt-0.5 text-ink-soft dark:text-white/50">
            插件在服务器上运行，用「{aiName}」的身份在频道和私信里收发消息，这台设备关着也照常工作。新传的和改过的插件要服务器管理员看过代码、批准以后才会运行。写插件看 docs/plugins.md。
          </div>
          {running && (
            <div className={cx('mt-2 font-medium', list.state === 'error' ? 'text-rose-500' : list.state === 'running' ? 'text-emerald-600 dark:text-emerald-400' : '')}>
              {STATE[list.state] ?? list.state}{list.error && `：${list.error}`}
            </div>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" aria-label="选择插件 zip"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <Button variant="primary" loading={uploading} onClick={() => fileRef.current?.click()}><FileArchive size={15} /> 上传插件</Button>
      </div>

      {list.plugins.length === 0 ? (
        <p className="py-6 text-center text-[0.85rem] text-ink-soft dark:text-white/50">
          还没有插件。把插件文件夹（带 __init__.py）打包成 zip 上传，一个 zip 里可以放好几个。
        </p>
      ) : (
        list.plugins.map((p) => (
          <PluginCard key={p.id} serverId={serverId} aiId={aiId} p={p} open={open === p.id} onOpen={() => setOpen(open === p.id ? null : p.id)}
            onChanged={changed} onDeleted={() => { setList((l) => l && { ...l, plugins: l.plugins.filter((x) => x.id !== p.id) }); refreshPluginCommands(serverId, aiId); }} />
        ))
      )}

      {list.log.length > 0 && (
        <div>
          <button type="button" className="press flex items-center gap-1.5 text-[0.85rem] text-ink-soft dark:text-white/60" onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>
            <ScrollText size={15} /> 运行日志 <ChevronDown size={14} className={cx('transition-transform duration-300 ease-[var(--ease-out)]', showLog && 'rotate-180')} />
          </button>
          {showLog && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-black/[0.04] p-3 font-mono text-[0.72rem] leading-relaxed dark:bg-white/5">
              {list.log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </>
  );
}

function PluginCard({ serverId, aiId, p, open, onOpen, onChanged, onDeleted }: {
  serverId: string; aiId: string; p: Plugin; open: boolean; onOpen: () => void; onChanged: (p: Plugin) => void; onDeleted: () => void;
}) {
  const s = session(serverId)!;
  const [label, cls] = STATUS[p.status];
  return (
    <div className="card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{p.name}</span>
            <span className="text-[0.75rem] text-ink-soft dark:text-white/40">{p.dir}</span>
            <span className={cx('rounded-full px-2 py-0.5 text-[0.72rem] font-medium', cls)}>{label}</span>
          </div>
          {p.description && <div className="mt-1 text-[0.85rem] text-ink-soft dark:text-white/60">{p.description}</div>}
          {p.status === 'rejected' && p.rejectReason && <div className="mt-1 text-[0.8rem] text-rose-500">管理员说：{p.rejectReason}</div>}
          {p.commands.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {p.commands.slice(0, 24).map((c) => <span key={c} className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[0.72rem] dark:bg-white/10">{c}</span>)}
              {p.commands.length > 24 && <span className="text-[0.72rem] text-ink-soft">等 {p.commands.length} 个命令</span>}
            </div>
          )}
        </div>
        <Toggle label={`启用 ${p.name}`} checked={p.enabled} onChange={(on) => s.updatePlugin(aiId, p.id, { enabled: on }).then(onChanged)} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="soft" size="sm" onClick={onOpen} aria-expanded={open}>
          <Settings2 size={14} /> {p.settings.length ? `设置（${p.settings.length}）` : '用法'}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" aria-label={`删除插件 ${p.name}`} onClick={() => ask({
          title: `删除插件「${p.name}」？`, text: '插件和它的设置都会删掉（它自己存的数据留在服务器上）。要用的话得重新上传，再等管理员审核。', ok: '删除', danger: true,
          run: async () => { await s.deletePlugin(aiId, p.id); onDeleted(); toast('已删除'); },
        })}><Trash2 size={14} /></Button>
      </div>
      {open && <PluginSettings serverId={serverId} aiId={aiId} p={p} onSaved={onChanged} />}
    </div>
  );
}

type Draft = Record<string, string | boolean>;

function draftOf(p: Plugin): Draft {
  const d: Draft = {};
  for (const st of p.settings) {
    const v = p.values[st.key];
    if (st.secret) d[st.key] = '';
    else if (st.type === 'bool') d[st.key] = v === undefined ? st.default === true : v === true || v === 'true';
    else d[st.key] = toText(st, v);
  }
  return d;
}

/** The settings form, generated from the plugin's declared / detected settings. */
function PluginSettings({ serverId, aiId, p, onSaved }: { serverId: string; aiId: string; p: Plugin; onSaved: (p: Plugin) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(p));
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(draftOf(p));
    setClear(new Set());
  }, [p.id]);

  const base = draftOf(p);
  const errors: Record<string, string> = {};
  const patch: Record<string, unknown> = {};
  for (const st of p.settings) {
    const v = draft[st.key];
    if (st.secret) {
      if (clear.has(st.key)) patch[st.key] = null;
      else if (typeof v === 'string' && v !== '') patch[st.key] = v;
      continue;
    }
    if (v === base[st.key]) continue;
    if (typeof v === 'boolean') {
      patch[st.key] = v;
      continue;
    }
    const r = fromText(st, v, p.values[st.key]);
    if ('error' in r) errors[st.key] = r.error;
    else patch[st.key] = r.value;
  }
  const dirty = Object.keys(patch).length > 0;
  const bad = Object.keys(errors).length > 0;

  async function save() {
    setBusy(true);
    try {
      const np = await session(serverId)!.updatePlugin(aiId, p.id, { config: patch });
      onSaved(np);
      setDraft(draftOf(np));
      setClear(new Set());
      toast(np.status === 'approved' && np.enabled ? '已保存，插件会重新启动' : '已保存');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const ql = q.trim().toLowerCase();
  const shown = ql ? p.settings.filter((st) => st.key.toLowerCase().includes(ql) || settingLabel(st, p.dir).toLowerCase().includes(ql) || st.help.includes(q.trim())) : p.settings;
  return (
    <div className="mt-3 space-y-3 border-t border-black/5 pt-3 dark:border-white/10">
      {p.usage && <pre className="whitespace-pre-wrap rounded-xl bg-black/[0.03] p-3 text-[0.8rem] leading-relaxed dark:bg-white/5">{p.usage}</pre>}
      {p.requires.length > 0 && <div className="text-[0.75rem] text-ink-soft dark:text-white/40">要用到的 Python 包（服务器会自动装）：{p.requires.join('、')}</div>}
      {p.settings.length > 10 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜设置项" aria-label="搜设置项" />}
      {groupSettings(shown).map(({ group, items }) => (
        <div key={group || '-'} className="space-y-2.5">
          {group && <div className="pt-1 text-[0.8rem] font-semibold text-ink-soft dark:text-white/60">{group}</div>}
          {items.map((st) => (
            <SettingRow key={st.key} st={st} dir={p.dir} value={draft[st.key]} error={errors[st.key]}
              secretSet={p.secretsSet.includes(st.key) && !clear.has(st.key)}
              onChange={(v) => setDraft((d) => ({ ...d, [st.key]: v }))}
              onClear={() => setClear((c) => new Set(c).add(st.key))} />
          ))}
        </div>
      ))}
      {p.settings.length === 0 && <p className="text-[0.8rem] text-ink-soft dark:text-white/50">没找到这个插件的设置项。作者可以在 am_plugin.json 里写上（见 docs/plugins.md）。</p>}
      {p.settings.length > 0 && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <Button variant="ghost" size="sm" onClick={() => { setDraft(draftOf(p)); setClear(new Set()); }}><RefreshCw size={14} /> 还原</Button>}
          <Button variant="primary" size="sm" loading={busy} disabled={!dirty || bad} onClick={save}>保存设置</Button>
        </div>
      )}
    </div>
  );
}

function SettingRow({ st, dir, value, error, secretSet, onChange, onClear }: {
  st: PluginSetting; dir: string; value: string | boolean | undefined; error?: string; secretSet: boolean;
  onChange: (v: string | boolean) => void; onClear: () => void;
}) {
  const label = settingLabel(st, dir);
  const def = st.default === undefined ? '' : toText(st, st.default);
  const hint = [st.help, st.type === 'list' ? '一行一个' : '', def && !st.secret && st.type !== 'bool' ? `不填就用默认：${def.length > 60 ? def.slice(0, 60) + '…' : def}` : '']
    .filter(Boolean).join(' · ');
  if (st.type === 'bool') {
    return (
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[0.85rem] font-medium">{label}</div>
          <div className="text-[0.72rem] text-ink-soft dark:text-white/40">{st.help || st.key}</div>
        </div>
        <Toggle label={label} checked={value === true} onChange={onChange} />
      </div>
    );
  }
  let input;
  if (st.type === 'select' && st.options.length) {
    input = (
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {st.options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(value === o ? '' : o)}
            className={cx('press rounded-lg px-2.5 py-1 text-[0.8rem]', value === o ? 'bg-accent text-white' : 'bg-black/[0.05] dark:bg-white/10')}>{o}</button>
        ))}
      </div>
    );
  } else if (st.type === 'list' || st.type === 'text') {
    input = <textarea className={cx(inputClass, 'min-h-[64px] resize-y py-2 font-mono text-[0.8rem]')} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={def} />;
  } else if (st.secret) {
    input = (
      <div className="flex gap-2">
        <Input type="password" autoComplete="off" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={label}
          placeholder={secretSet ? '已经填过了（不显示），留空不改' : '没有填'} />
        {secretSet && <Button variant="ghost" size="sm" onClick={onClear}>清除</Button>}
      </div>
    );
  } else {
    input = <Input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-label={label} placeholder={def}
      inputMode={st.type === 'int' || st.type === 'float' ? 'decimal' : undefined} />;
  }
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[0.85rem] font-medium">{label}</span>
        {label !== st.key && <span className="text-[0.7rem] text-ink-soft/70 dark:text-white/30">{st.key}</span>}
      </div>
      {input}
      {(error || hint) && <div className={cx('mt-1 text-[0.72rem]', error ? 'text-rose-500' : 'text-ink-soft dark:text-white/40')}>{error || hint}</div>}
    </div>
  );
}
