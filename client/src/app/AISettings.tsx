// Managing my AIs on the AI page (docs/design.md §9, §10): creating one,
// its settings (persona, model, profile, which device runs it) and the model
// providers I have keys for. The AI itself runs in lib/ai/runner.ts.
import { useEffect, useRef, useState } from 'react';
import { Cpu, ImageUp, KeyRound, Monitor, Pencil, Plus, Trash2 } from 'lucide-react';
import { deviceId } from '@/lib/deviceId';
import { errorText } from '@/lib/errors';
import { newProviderId, putProvider, removeProvider, useProviders } from '@/lib/ai/keys';
import { TEMPLATES, defaultSettings, type AISettings } from '@/lib/ai/persona';
import { KIND_LABEL, PRESETS, buildRequest, errorOf, streamReader, type Provider, type ProviderKind } from '@/lib/ai/providers';
import { aiSettings, refreshAIs, runHere, saveSettings, useAI } from '@/lib/ai/runner';
import { openConv, session, useApp } from '@/lib/store';
import { aiRequest } from '@/lib/transport';
import { Button, Dialog, Field, Input, Segmented, Spinner, Toggle, ask, cx, inputClass, toast, toastError } from '@/ui';
import { UserAvatar } from './media';

const textarea = cx(inputClass, 'min-h-[84px] resize-y py-2.5 leading-relaxed');

/** "新建 AI": name and a starting persona; it runs on this device. */
export function CreateAIDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const providers = useProviders((s) => s.list);
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState(TEMPLATES[0].key);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  async function create() {
    const s = session(serverId);
    if (!s || !name.trim() || busy) return;
    setBusy(true);
    try {
      const info = await s.createAI(name.trim());
      const template = TEMPLATES.find((t) => t.key === tpl) ?? TEMPLATES[0];
      const p = providers[0];
      const preset = p && PRESETS.find((x) => x.baseUrl === p.baseUrl);
      const settings: AISettings = { ...defaultSettings(template), providerId: p?.id ?? '', model: preset?.model ?? '' };
      await s.putAISettings(info.user.id, JSON.stringify(settings), 0);
      await refreshAIs(serverId);
      await runHere(serverId, info.user.id);
      openConv(await s.openDM(info.user.id));
      onClose();
      toast(p ? `「${info.user.name}」创建好了，在这台设备上运行` : `「${info.user.name}」创建好了。先在设置的「模型」里填一个服务商和 key，它才能回话`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="新建 AI" width={480}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <Field label="名字" hint="大家看到的名字，以后能改">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="例如：小鱼" autoFocus required />
        </Field>
        <div>
          <div className="mb-1.5 text-[0.85rem] font-medium text-ink-soft dark:text-white/60">从哪个人格开始（创建后随便改）</div>
          <div className="grid grid-cols-3 gap-2">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.key}
                onClick={() => setTpl(t.key)}
                aria-pressed={tpl === t.key}
                className={cx('lift rounded-2xl p-3 text-left', tpl === t.key ? 'bg-accent text-white shadow-[0_8px_20px_-10px_var(--accent)]' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/5')}
              >
                <div className="font-semibold">{t.name}</div>
                <div className={cx('mt-0.5 text-[0.75rem]', tpl === t.key ? 'text-white/85' : 'text-ink-soft dark:text-white/50')}>{t.persona.intro}</div>
              </button>
            ))}
          </div>
        </div>
        <p className="text-[0.8rem] text-ink-soft dark:text-white/50">AI 在这台设备上运行，用你自己的模型 key；这台设备关着的时候它回不了话。</p>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!name.trim()}>创建</Button>
      </form>
    </Dialog>
  );
}

type Tab = 'persona' | 'model' | 'profile' | 'run';

/** One AI's settings. */
export function AISettingsDialog({ open, onClose, aiId }: { open: boolean; onClose: () => void; aiId: string }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const info = useAI((s) => s.byServer[serverId]?.find((a) => a.user.id === aiId));
  const [tab, setTab] = useState<Tab>('persona');
  const [draft, setDraft] = useState<AISettings>(() => aiSettings(serverId, aiId));
  useEffect(() => {
    if (open) setDraft(aiSettings(serverId, aiId));
  }, [open, serverId, aiId, info?.updatedAt]);
  const set = (p: Partial<AISettings>) => setDraft((d) => ({ ...d, ...p }));
  const save = () => saveSettings(serverId, aiId, draft).then(() => toast('已保存'));

  return (
    <Dialog open={open} onClose={onClose} title={`「${info?.user.name ?? 'AI'}」的设置`} width={600}>
      <div className="mb-4">
        <Segmented id="ai-tab" value={tab} onChange={setTab} options={[
          { value: 'persona', label: '人格' }, { value: 'model', label: '模型' }, { value: 'profile', label: '资料' }, { value: 'run', label: '运行' },
        ]} />
      </div>
      {!info ? (
        <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>
      ) : (
        <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
          {tab === 'persona' && <PersonaTab draft={draft} set={set} save={save} />}
          {tab === 'model' && <ModelTab draft={draft} set={set} save={save} />}
          {tab === 'profile' && <ProfileTab serverId={serverId} aiId={aiId} />}
          {tab === 'run' && <RunTab serverId={serverId} aiId={aiId} draft={draft} set={set} save={save} onDeleted={onClose} />}
        </div>
      )}
    </Dialog>
  );
}

type TabProps = { draft: AISettings; set: (p: Partial<AISettings>) => void; save: () => Promise<void> };

function PersonaTab({ draft, set, save }: TabProps) {
  const p = draft.persona;
  const setP = (x: Partial<AISettings['persona']>) => set({ persona: { ...p, ...x } });
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[0.85rem]">
        <span className="text-ink-soft dark:text-white/55">换成模板：</span>
        {TEMPLATES.map((t) => (
          <button key={t.key} type="button" onClick={() => set({ persona: { ...t.persona }, template: t.key })} className="press rounded-lg bg-black/[0.04] px-2.5 py-1 hover:bg-black/[0.07] dark:bg-white/5 dark:hover:bg-white/10">
            {t.name}
          </button>
        ))}
      </div>
      <Field label="一句话介绍"><Input value={p.intro} onChange={(e) => setP({ intro: e.target.value })} maxLength={80} /></Field>
      <Field label="性格和说话方式" hint="直接写给它看的话，比如「你是……，说话……」">
        <textarea value={p.system} onChange={(e) => setP({ system: e.target.value })} maxLength={4000} className={textarea} rows={5} />
      </Field>
      <Field label="示例对话" hint="一行一句，「我：」开头是你说的，「它：」开头是它说的">
        <textarea value={p.examples} onChange={(e) => setP({ examples: e.target.value })} maxLength={2000} className={textarea} rows={3} />
      </Field>
      <Field label="开场白" hint="第一次运行时它对你说的第一句话">
        <Input value={p.greeting} onChange={(e) => setP({ greeting: e.target.value })} maxLength={200} />
      </Field>
      <div className="flex justify-end"><Button variant="primary" onClick={save}>保存人格</Button></div>
    </>
  );
}

function ModelTab({ draft, set, save }: TabProps) {
  const providers = useProviders((s) => s.list);
  const [manage, setManage] = useState(false);
  return (
    <>
      <Field label="模型服务商">
        <div className="flex gap-2">
          <select value={draft.providerId} onChange={(e) => set({ providerId: e.target.value })} className={cx(inputClass, 'h-11 flex-1')} aria-label="模型服务商">
            <option value="">（还没选）</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND_LABEL[p.kind]}</option>)}
          </select>
          <Button variant="soft" onClick={() => setManage(true)}><KeyRound size={15} /> 管理服务商</Button>
        </div>
      </Field>
      <Field label="模型名" hint="服务商那边的模型名字，例如 deepseek-chat">
        <Input value={draft.model} onChange={(e) => set({ model: e.target.value.trim() })} placeholder="deepseek-chat" aria-label="模型名" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label={`随机程度 ${draft.temperature.toFixed(1)}`} hint="越大越活泼，越小越稳">
          <input type="range" min={0} max={1.5} step={0.1} value={draft.temperature} onChange={(e) => set({ temperature: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
        </Field>
        <Field label="记得最近几条" hint="越多越懂上下文，也越费钱">
          <Input type="number" min={2} max={200} value={draft.contextSize} onChange={(e) => set({ contextSize: Math.max(2, Math.min(200, Number(e.target.value) || 30)) })} />
        </Field>
        <Field label="每条最长" hint="大约多少个字（token）">
          <Input type="number" min={50} max={8000} value={draft.maxTokens} onChange={(e) => set({ maxTokens: Math.max(50, Math.min(8000, Number(e.target.value) || 1000)) })} />
        </Field>
      </div>
      <div className="flex justify-end"><Button variant="primary" onClick={save}>保存模型设置</Button></div>
      <ProvidersDialog open={manage} onClose={() => setManage(false)} />
    </>
  );
}

function ProfileTab({ serverId, aiId }: { serverId: string; aiId: string }) {
  const user = useApp((s) => s.sessions[serverId]?.users[aiId]);
  const [name, setName] = useState(user?.name ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const s = () => session(serverId)!;
  const avatar = async (f: File) => {
    setUploading(true);
    try {
      const m = await s().upload(f);
      await s().updateAI(aiId, { avatarMediaId: m.id });
      toast('头像已更新');
    } catch (e) {
      toastError(e);
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <div className="flex items-center gap-4">
        <button onClick={() => file.current?.click()} disabled={uploading} aria-busy={uploading || undefined} className="press group relative rounded-full" aria-label="更换 AI 头像">
          <UserAvatar user={user} size={72} animated />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            {uploading ? <Spinner size={20} /> : <ImageUp size={20} />}
          </span>
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void avatar(f); e.target.value = ''; }} />
        <div className="text-[0.85rem] text-ink-soft dark:text-white/55">点头像换图（GIF 也行）。立绘以后在这里换形象包。</div>
      </div>
      <Field label="名字"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} /></Field>
      <Field label="个性签名"><Input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={100} /></Field>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!name.trim()} onClick={() => s().updateAI(aiId, { displayName: name.trim(), bio: bio.trim() }).then(() => toast('已保存'))}>保存资料</Button>
      </div>
    </>
  );
}

function RunTab({ serverId, aiId, draft, set, save, onDeleted }: TabProps & { serverId: string; aiId: string; onDeleted: () => void }) {
  const here = draft.runner?.id === deviceId();
  const running = useAI((s) => s.running[`${serverId}|${aiId}`]);
  const error = useAI((s) => s.errors[`${serverId}|${aiId}`]);
  return (
    <>
      <div className="card flex items-center gap-3 rounded-2xl p-4">
        <Monitor size={20} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">运行在：{draft.runner ? `${draft.runner.name}${here ? '（这台设备）' : ''}` : '还没有设备'}</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">
            AI 只在一台设备上运行，用这台设备上的模型 key 回话。那台设备关着时它就离线。
            {here && (running ? ' 现在已连上。' : ' 正在连接…')}
          </div>
          {error && <div className="mt-1 text-[0.8rem] text-rose-500">最近一次出错：{error}</div>}
        </div>
        {!here && <Button variant="primary" onClick={() => runHere(serverId, aiId).then(() => toast('现在由这台设备运行'))}><Cpu size={15} /> 在这台设备上运行</Button>}
      </div>
      <Field label="谁能和它聊">
        <Segmented id="ai-who" value={draft.whoCanChat} onChange={(w) => set({ whoCanChat: w })} options={[
          { value: 'owner', label: '只有我' }, { value: 'everyone', label: '服务器里所有人' },
        ]} />
      </Field>
      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="font-medium">自己维护人格</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">打开后它会定期根据聊天慢慢调整自己的人格设定，不打扰你。（下一批上线）</div>
        </div>
        <Toggle label="自己维护人格" checked={draft.evolve} onChange={(on) => set({ evolve: on })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="danger"
          onClick={() => ask({
            title: '删除这个 AI？', text: '它会退出所有频道，不能再聊天，以前的消息还在。删除后不能恢复。', ok: '删除', danger: true,
            run: async () => {
              await session(serverId)!.deleteAI(aiId);
              await refreshAIs(serverId);
              onDeleted();
              toast('已删除');
            },
          })}
        >
          <Trash2 size={15} /> 删除 AI
        </Button>
        <Button variant="primary" onClick={save}>保存</Button>
      </div>
    </>
  );
}

/** The model services I have keys for (all my AIs and devices share them). */
export function ProvidersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useProviders((s) => s.list);
  const [edit, setEdit] = useState<Provider | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="模型服务商" width={520}>
      {edit ? (
        <ProviderForm initial={edit} onDone={() => setEdit(null)} />
      ) : (
        <div className="space-y-2">
          <p className="text-[0.85rem] text-ink-soft dark:text-white/55">
            key 存在系统的凭据管理器里，加密同步到你的其他设备，服务器看不到。花的是你自己账户里的钱。
          </p>
          {list.map((p) => (
            <div key={p.id} className="card flex items-center gap-3 rounded-2xl p-3">
              <KeyRound size={18} className="shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                <div className="truncate text-[0.78rem] text-ink-soft dark:text-white/50">{KIND_LABEL[p.kind]} · {p.baseUrl}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEdit(p)} aria-label={`编辑 ${p.name}`}><Pencil size={14} /></Button>
              <Button size="sm" variant="ghost" onClick={() => ask({ title: `删除「${p.name}」？`, text: '用它的 AI 会回不了话，直到换一个服务商。', ok: '删除', danger: true, run: () => removeProvider(p.id) })} aria-label={`删除 ${p.name}`}><Trash2 size={14} /></Button>
            </div>
          ))}
          {!list.length && <p className="py-4 text-center text-[0.9rem] text-ink-soft dark:text-white/45">还没有服务商</p>}
          <Button
            variant="primary"
            className="w-full"
            onClick={() => setEdit({ id: newProviderId(), kind: PRESETS[0].kind, name: PRESETS[0].name, baseUrl: PRESETS[0].baseUrl, key: '' })}
          >
            <Plus size={16} /> 添加服务商
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function ProviderForm({ initial, onDone }: { initial: Provider; onDone: () => void }) {
  const [p, setP] = useState(initial);
  const [model, setModel] = useState(PRESETS.find((x) => x.baseUrl === initial.baseUrl)?.model ?? '');
  const [test, setTest] = useState('');
  const set = (x: Partial<Provider>) => setP((o) => ({ ...o, ...x }));

  async function tryIt() {
    setTest('…');
    try {
      const r = buildRequest(p, { model, system: '只回答一个字：好', messages: [{ role: 'user', content: '你好' }], temperature: 0, maxTokens: 20 });
      const rd = streamReader(p.kind);
      let out = '';
      const status = await aiRequest(r.url, r.headers, r.body, (c) => (out += rd.feed(c)));
      setTest(status < 400 ? `能用 ✓ 它说：${out.trim() || '（空）'}` : `不行（${status}）：${errorOf(rd.raw())}`);
    } catch (e) {
      setTest(`不行：${errorText(e)}`);
    }
  }

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void putProvider(p).then(onDone); }}>
      <Field label="常用的">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((x) => (
            <button
              type="button"
              key={x.name}
              onClick={() => { set({ kind: x.kind, baseUrl: x.baseUrl, name: x.name }); setModel(x.model); }}
              className={cx('press rounded-lg px-2.5 py-1 text-[0.85rem]', p.baseUrl === x.baseUrl ? 'bg-accent text-white' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/5')}
            >
              {x.name}
            </button>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="名字"><Input value={p.name} onChange={(e) => set({ name: e.target.value })} maxLength={40} required /></Field>
        <Field label="接口类型">
          <select value={p.kind} onChange={(e) => set({ kind: e.target.value as ProviderKind })} className={cx(inputClass, 'h-11')} aria-label="接口类型">
            {(Object.keys(KIND_LABEL) as ProviderKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="接口地址"><Input value={p.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} required aria-label="接口地址" /></Field>
      <Field label="key"><Input type="password" value={p.key} onChange={(e) => set({ key: e.target.value.trim() })} placeholder="sk-..." autoComplete="off" aria-label="key" /></Field>
      <div className="flex items-end gap-2">
        <div className="flex-1"><Field label="测试用的模型名"><Input value={model} onChange={(e) => setModel(e.target.value.trim())} aria-label="测试用的模型名" /></Field></div>
        <Button variant="soft" disabled={!p.baseUrl || !model} onClick={tryIt}>测试</Button>
      </div>
      {test && <p className={cx('text-[0.85rem]', test.startsWith('能用') ? 'text-emerald-600 dark:text-emerald-300' : 'text-ink-soft dark:text-white/60')}>{test}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>返回</Button>
        <Button type="submit" variant="primary" disabled={!p.name.trim() || !p.baseUrl}>保存</Button>
      </div>
    </form>
  );
}
