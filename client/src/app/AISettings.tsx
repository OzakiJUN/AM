// Managing my AIs on the AI page (docs/design.md §9, §10): creating one,
// its settings (persona, model, profile, which device runs it) and the model
// providers I have keys for. The AI itself runs in lib/ai/runner.ts.
import { useEffect, useRef, useState } from 'react';
import { Cpu, Folder, Server, Gamepad2, Hash, ImageUp, KeyRound, LayoutGrid, Lock, Users, Monitor, Pencil, Plug, Plus, ShieldAlert, Store, Trash2, X } from 'lucide-react';
import { CATEGORY_LABEL, GAME_TEMPLATES } from '@/lib/ai/agent';
import { readLog, type LogEntry } from '@/lib/ai/agentState';
import type { Level, McpServer, ToolCategory } from '@/lib/ai/persona';
import type { User } from '@/lib/types';
import { biliLogin, listMcpTools, stopMcp, type BiliState } from '@/lib/ai/tools';
import QRCode from 'qrcode';
import { chatTime } from '@/lib/format';
import { inTauri, openUrl } from '@/lib/platform';
import { deviceId } from '@/lib/deviceId';
import { errorText } from '@/lib/errors';
import { newProviderId, putProvider, removeProvider, useProviders } from '@/lib/ai/keys';
import { TEMPLATES, defaultSettings, type AISettings } from '@/lib/ai/persona';
import { KIND_LABEL, PRESETS, chatProviders, balanceQuery, balanceText, buildRequest, errorOf, streamReader, modelsQuery, parseModels, isDeepSeek, type Provider, type ProviderKind } from '@/lib/ai/providers';
import { checkBalance, useBalance } from '@/lib/ai/balance';
import { aiSettings, refreshAIs, runHere, saveSettings, useAI } from '@/lib/ai/runner';
import { openConv, openProfile, session, useApp } from '@/lib/store';
import { aiGet, aiRequest } from '@/lib/transport';
import { Button, Dialog, Field, Input, Segmented, Slider, Spinner, Toggle, ask, cx, inputClass, openMenu, toast, toastError } from '@/ui';
import { UserAvatar, mediaPath, useMediaUrl } from './media';
import { forgetPack } from './Portrait';
import { MOODS, MOOD_LABEL, packFromFiles, type Mood } from '@/lib/portraits';
import { personaTemplates, portraitFiles, useWorkshop } from '@/lib/workshop';

const textarea = cx(inputClass, 'min-h-[84px] resize-y py-2.5 leading-relaxed');

/** "新建 AI": name and a starting persona; it runs on this device. */
export function CreateAIDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const providers = useProviders((s) => s.list);
  const [name, setName] = useState('');
  const [tpl, setTpl] = useState(TEMPLATES[0].key);
  const templates = personaTemplates(useWorkshop((s) => s.metas));
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
      const template = templates.find((t) => t.key === tpl) ?? TEMPLATES[0];
      const p = chatProviders(providers)[0];
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
            {templates.map((t) => (
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

type Tab = 'persona' | 'model' | 'social' | 'computer' | 'profile' | 'run' | 'log';

/** One AI's settings. */
/** The server's built-in bot's name, avatar, signature and page (site admins). */
export function HelperProfileDialog({ open, onClose, serverId, botId }: { open: boolean; onClose: () => void; serverId: string; botId: string }) {
  return (
    <Dialog open={open} onClose={onClose} title="小助手的资料" width={480}>
      {open && (
        <div className="space-y-4" data-testid="helper-profile">
          <p className="text-[0.85rem] text-ink-soft dark:text-white/55">服务器自带的 bot，只有站点管理员能改。它会的指令（游戏资讯、电子厕所……）在服务器上，不用在这里设置。</p>
          <ProfileTab serverId={serverId} aiId={botId} onClose={onClose} portraits={false} />
        </div>
      )}
    </Dialog>
  );
}

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
          { value: 'persona', label: '人格' }, { value: 'model', label: '模型' }, { value: 'social', label: '频道与作息' },
          { value: 'computer', label: '电脑' }, { value: 'profile', label: '资料' }, { value: 'run', label: '运行' }, { value: 'log', label: '记录' },
        ]} />
      </div>
      {!info ? (
        <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>
      ) : (
        <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
          {tab === 'persona' && <PersonaTab draft={draft} set={set} save={save} />}
          {tab === 'model' && <ModelTab serverId={serverId} aiId={aiId} draft={draft} set={set} save={save} />}
          {tab === 'computer' && <ComputerTab draft={draft} set={set} save={save} />}
          {tab === 'social' && <SocialTab serverId={serverId} aiId={aiId} draft={draft} set={set} save={save} />}
          {tab === 'log' && <LogTab logKey={`${serverId}|${aiId}`} />}
          {tab === 'profile' && <ProfileTab serverId={serverId} aiId={aiId} onClose={onClose} />}
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
  const templates = personaTemplates(useWorkshop((s) => s.metas));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-[0.85rem]">
        <span className="text-ink-soft dark:text-white/55">换成模板：</span>
        {templates.map((t) => (
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
      {!!draft.personaHistory?.length && (
        <details className="rounded-2xl bg-black/[0.03] p-3 text-[0.85rem] dark:bg-white/[0.04]">
          <summary className="cursor-pointer text-ink-soft dark:text-white/55">它自己改过 {draft.personaHistory.length} 次人格，可以退回以前的版本</summary>
          <div className="mt-2 space-y-1.5">
            {[...draft.personaHistory].reverse().map((h) => (
              <div key={h.at} className="flex items-center gap-2 rounded-xl bg-white/60 px-3 py-2 dark:bg-white/5">
                <span className="shrink-0 text-ink-soft tabular-nums dark:text-white/50">{new Date(h.at).toLocaleDateString('zh-CN')} 以前</span>
                <span className="min-w-0 flex-1 truncate" title={h.persona.system}>{h.persona.intro || h.persona.system.slice(0, 40)}</span>
                <Button size="sm" variant="ghost" onClick={() => setP({ ...h.persona })}>用这个版本</Button>
              </div>
            ))}
            <p className="text-[0.78rem] text-ink-soft dark:text-white/45">点「用这个版本」后记得保存。</p>
          </div>
        </details>
      )}
    </>
  );
}

function ModelTab({ serverId, aiId, draft, set, save }: TabProps & { serverId: string; aiId: string }) {
  const providers = useProviders((s) => s.list);
  const [manage, setManage] = useState(false);
  const provider = providers.find(p => p.id === draft.providerId);
  const [models, setModels] = useState<{ provider: string; ids: string[] } | null>(null);
  const [result, setResult] = useState('');
  const [loading, setLoading] = useState(false);
  const actual = useAI(s => s.models[`${serverId}|${aiId}`]);
  const listModels = async () => {
    if (!provider) return;
    setLoading(true); setResult('正在获取模型…');
    try {
      const q = modelsQuery(provider), res = await aiGet(q.url, q.headers);
      setModels({ provider: provider.id, ids: parseModels(res.status, res.body) }); setResult('已获取模型，选择后记得保存');
    } catch(e) { setResult(errorText(e)); } finally { setLoading(false); }
  };
  const testModel = async () => {
    if (!provider || !draft.model) return;
    setLoading(true); setResult('正在测试当前填写的模型…');
    try {
      const req = buildRequest(provider, { model: draft.model, system: '只回答：好', messages: [{ role: 'user', content: '你好' }], temperature: 0, maxTokens: 50, thinking: draft.thinking, thinkingBudget: draft.thinkingBudget });
      const rd = streamReader(provider.kind); let out = '';
      const status = await aiRequest(req.url, req.headers, req.body, c => { out += rd.feed(c); });
      if (status >= 400) throw new Error(`测试失败（${status}）：${errorOf(rd.raw())}`);
      setResult(`请求模型：${draft.model}；服务商返回模型：${rd.model() ?? '未提供'}；回复：${out.trim() || '（无文字回复）'}${rd.finish() === 'length' ? '（达到输出上限）' : ''}`);
    } catch(e) { setResult(errorText(e)); } finally { setLoading(false); }
  };
  return (
    <>
      <Field label="模型服务商">
        <div className="flex gap-2">
          <select value={draft.providerId} onChange={(e) => set({ providerId: e.target.value })} className={cx(inputClass, 'h-11 flex-1')} aria-label="模型服务商">
            <option value="">（还没选）</option>
            {chatProviders(providers).map((p) => <option key={p.id} value={p.id}>{p.name} · {KIND_LABEL[p.kind]}</option>)}
          </select>
          <Button variant="soft" onClick={() => setManage(true)}><KeyRound size={15} /> 管理服务商</Button>
        </div>
      </Field>
      <Field label="模型名" hint="这里才是 AI 聊天使用的模型。可获取服务商模型列表，也可手填；修改后保存生效。">
        <Input list="ai-model-list" value={draft.model} onChange={(e) => set({ model: e.target.value.trim() })} placeholder="例如 deepseek-flash" aria-label="模型名" />
        <datalist id="ai-model-list">{models?.provider === draft.providerId && models.ids.map(id => <option key={id} value={id} />)}</datalist>
        <div className="mt-2 flex gap-2"><Button variant="soft" disabled={!provider || loading} onClick={listModels}>获取可用模型</Button><Button variant="soft" disabled={!provider || !draft.model || loading} onClick={testModel}>测试当前 AI 模型</Button></div>
        {result && <p role="status" className="mt-2 break-all text-xs">{result}</p>}
        {actual && <p className="mt-2 break-all text-xs">最近实际聊天：请求 {actual.requested}；服务商返回 {actual.reported ?? '未提供'}（{new Date(actual.at).toLocaleString('zh-CN')}）</p>}
        <p className="mt-2 text-xs text-ink-soft">返回名称来自 API 响应，不采用 AI 自述；中转服务的名称映射仍需向服务商核实。</p>
      </Field>
      {provider && isDeepSeek(provider) && /^deepseek-(chat|reasoner)$/.test(draft.model) && <p className="text-xs text-amber-700 dark:text-amber-300">当前填写的是旧模型名。请获取可用模型后重新选择并保存，避免旧别名失效或映射不清。</p>}
      {provider && isDeepSeek(provider) && <Field label="DeepSeek 思考模式" hint="开启后保留思考；额外预算与回复上限合并，思考和正文共用总输出额度，会增加 token 用量。">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!draft.thinking} onChange={e => set({ thinking: e.target.checked })} />启用思考</label>
        {draft.thinking && <label className="mt-2 block">额外输出预算（含思考，token）<Input type="number" min={1024} max={32768} step={1024} value={draft.thinkingBudget ?? 8192} onChange={e => set({ thinkingBudget: Math.max(1024, Math.min(32768, Number(e.target.value) || 8192)) })} /></label>}
      </Field>}
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

/** Operating this computer: on / off, work folders, what it may do. */
function ComputerTab({ draft, set, save }: TabProps) {
  const c = draft.computer;
  const setC = (x: Partial<AISettings['computer']>) => set({ computer: { ...c, ...x } });
  const setLevel = async (cat: ToolCategory, level: Level) => {
    if (level === 'allow' && CATEGORY_LABEL[cat].risky) {
      const ok = await ask({
        title: `让它${CATEGORY_LABEL[cat].name}不用问你？`,
        text: `${CATEGORY_LABEL[cat].hint}。打开后它会自己判断要不要做，做了也只记在「记录」里。确定吗？`,
        ok: '确定', danger: true,
      });
      if (ok === null) return;
    }
    setC({ levels: { ...c.levels, [cat]: level } });
  };
  const addDir = async () => {
    let dir: string | null = null;
    if (inTauri) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const r = await open({ directory: true, multiple: false, title: '选一个让 AI 用的文件夹' });
      dir = typeof r === 'string' ? r : null;
    } else {
      dir = await ask({ title: '添加工作目录', ok: '添加', input: { label: '文件夹路径', placeholder: 'D:\\AI', required: true } });
    }
    if (dir && !c.workDirs.includes(dir)) setC({ workDirs: [...c.workDirs, dir] });
  };
  return (
    <>
      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="font-medium">让它操作运行它的这台电脑</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">只在 Windows 版可用。操作时屏幕上方有提示条，点「停止」或按 F12 马上停。</div>
        </div>
        <Toggle label="让它操作电脑" checked={c.enabled} onChange={(on) => setC({ enabled: on })} />
      </div>
      {c.enabled && draft.whoCanChat === 'everyone' && (
        <p className="flex gap-2 rounded-xl bg-amber-50 p-2.5 text-[0.8rem] text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          「谁能和它聊」是所有人：服务器里的人都能让它操作你的电脑（按下面的权限）。它会知道是谁在说话，但最终怎么做由它自己判断。
        </p>
      )}
      <Field label="工作目录" hint="文件只能在这些文件夹里读写，命令从第一个文件夹开始运行（命令本身能碰到别的地方）">
        <div className="space-y-1.5">
          {c.workDirs.map((d) => (
            <div key={d} className="flex items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
              <Folder size={15} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate font-mono text-[0.82rem]" title={d}>{d}</span>
              <button type="button" onClick={() => setC({ workDirs: c.workDirs.filter((x) => x !== d) })} aria-label={`移除 ${d}`} className="press rounded-md p-1 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><X size={14} /></button>
            </div>
          ))}
          <Button size="sm" variant="soft" onClick={addDir}><Plus size={14} /> 添加文件夹</Button>
        </div>
      </Field>
      <div>
        <div className="mb-1.5 text-[0.85rem] font-medium text-ink-soft dark:text-white/60">它能做什么</div>
        <div className="space-y-1.5">
          {(Object.keys(CATEGORY_LABEL) as ToolCategory[]).map((cat) => (
            <div key={cat} role="group" aria-label={CATEGORY_LABEL[cat].name} className="flex flex-wrap items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[0.9rem] font-medium">{CATEGORY_LABEL[cat].name}{CATEGORY_LABEL[cat].risky && <ShieldAlert size={13} className="text-amber-500" aria-label="有风险" />}</div>
                <div className="text-[0.75rem] text-ink-soft dark:text-white/45">{CATEGORY_LABEL[cat].hint}</div>
              </div>
              <Segmented id={`lvl-${cat}`} value={c.levels[cat]} onChange={(l) => void setLevel(cat, l)} options={[
                { value: 'allow', label: '允许' }, { value: 'ask', label: '问我' }, { value: 'deny', label: '不行' },
              ]} />
            </div>
          ))}
        </div>
      </div>
      {c.levels.mcp !== 'deny' && <McpList list={c.mcp} onChange={(mcp) => setC({ mcp })} />}
      <div className="grid grid-cols-3 gap-3">
        <Field label="模型能看图" hint="能看图的模型才打开（截图会发给模型服务商）">
          <Toggle label="模型能看图" checked={c.vision} onChange={(on) => setC({ vision: on })} />
        </Field>
        <Field label="一次最多几步" hint="防止它一直停不下来">
          <Input type="number" min={1} max={100} value={c.maxSteps} onChange={(e) => setC({ maxSteps: Math.max(1, Math.min(100, Number(e.target.value) || 20)) })} />
        </Field>
        <Field label="让鼠标（秒）" hint="你动了鼠标键盘后，等你停手几秒它才继续">
          <Input type="number" min={1} max={60} value={c.yieldSeconds} onChange={(e) => setC({ yieldSeconds: Math.max(1, Math.min(60, Number(e.target.value) || 3)) })} />
        </Field>
      </div>
      {inTauri && c.enabled && c.levels.browser !== 'deny' && <BiliLogin />}
      <div className="flex justify-end"><Button variant="primary" onClick={save}>保存</Button></div>
    </>
  );
}

/** The AI browser's Bilibili login on this device (QR scan with the B站 app):
 * logged in, its surfing gets subtitles and full comments. Shared by every
 * AI this device runs; the cookies stay in the AI's background browser. */
function BiliLogin() {
  const [state, setState] = useState<BiliState | null>(null);
  const [failed, setFailed] = useState('');
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    let live = true;
    biliLogin.status().then((s) => live && setState(s)).catch((e) => live && setFailed(errorText(e)));
    return () => {
      live = false;
    };
  }, []);
  const logout = async () => {
    const ok = await ask({ title: '退出 B 站登录？', text: 'AI 浏览器里的 B 站登录会被清掉，之后看视频拿不到字幕。', ok: '退出' });
    if (ok === null) return;
    setState(await biliLogin.logout());
    toast('已退出 B 站');
  };
  return (
    <Field label="AI 浏览器登录 B 站" hint="登录后它冲浪时能看到字幕和完整评论。这台电脑上的 AI 共用，最好用小号">
      <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]" data-testid="bili-login">
        <span className="min-w-0 flex-1 truncate text-[0.88rem]">
          {failed ? <span className="text-rose-500">{failed}</span> : !state ? <Spinner /> : state.login ? `已登录：${state.name || 'B 站账号'}` : '没登录'}
        </span>
        {state?.login ? (
          <Button size="sm" variant="soft" key="bili-out" onClick={logout}>退出登录</Button>
        ) : (
          <Button size="sm" variant="soft" key="bili-in" onClick={() => setScanning(true)}>扫码登录</Button>
        )}
      </div>
      <BiliQrDialog open={scanning} onClose={() => setScanning(false)} onDone={(s) => { setState(s); setFailed(''); setScanning(false); toast(`B 站已登录：${s.name}`); }} />
    </Field>
  );
}

function BiliQrDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (s: BiliState) => void }) {
  const [qr, setQr] = useState('');
  const [key, setKey] = useState('');
  const [code, setCode] = useState(86101);
  const [error, setError] = useState('');
  const make = async () => {
    setQr('');
    setError('');
    setCode(86101);
    try {
      const r = await biliLogin.start();
      setKey(r.key);
      setQr(await QRCode.toDataURL(r.url, { margin: 1, width: 420, color: { dark: '#2a2440', light: '#ffffff' } }));
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    if (open) void make();
    else setKey('');
  }, [open]);
  // Ask every 2 s how the scan is going, until it is done or expired.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!open || !key || code === 86038) return;
    let live = true;
    const t = setInterval(() => {
      biliLogin.poll(key).then((r) => {
        if (!live) return;
        if (r.code === 0) done.current({ login: true, name: r.name ?? '' });
        else setCode(r.code);
      }).catch(() => {});
    }, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [open, key, code === 86038]);
  const expired = code === 86038;
  return (
    <Dialog open={open} onClose={onClose} title="AI 浏览器登录 B 站" width={400}>
      {error ? (
        <div className="space-y-4">
          <p className="text-rose-500" role="alert">{error}</p>
          <Button className="w-full" onClick={make}>再试一次</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[0.85rem] text-ink-soft dark:text-white/60">用 B 站手机 App 扫一扫（首页左上角头像旁边），在手机上确认登录。登录只存在 AI 自己的浏览器里，不会碰你平时用的浏览器。</p>
          <div className={cx('mx-auto aspect-square w-52 overflow-hidden rounded-2xl bg-white p-2 shadow-[var(--shadow-card)]', expired && 'opacity-30')}>
            {qr ? <img src={qr} alt="B 站登录二维码" className="h-full w-full" /> : <div className="flex h-full items-center justify-center text-ink-soft"><Spinner /></div>}
          </div>
          <div className="flex items-center gap-2">
            <span className={cx('flex-1 text-[0.85rem]', code === 86090 ? 'text-emerald-600 dark:text-emerald-300' : expired ? 'text-rose-500' : 'text-ink-soft dark:text-white/50')} role="status">
              {code === 86090 ? '扫到了，在手机上点确认' : expired ? '二维码过期了' : '等你扫码…'}
            </span>
            {expired && <Button size="sm" variant="primary" onClick={make}>刷新</Button>}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Which channels it is in, how much it talks there, and its day. */
/** People who asked to chat with my AI: 同意 = into its shared chat (made if there is none). */
function ShareRequests({ serverId, aiId }: { serverId: string; aiId: string }) {
  const count = useAI((s) => s.byServer[serverId]?.find((a) => a.user.id === aiId)?.shareRequests ?? 0);
  const [list, setList] = useState<User[] | null>(null);
  useEffect(() => {
    let live = true;
    session(serverId)?.shareRequests(aiId).then((l) => live && setList(l)).catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [serverId, aiId, count]);
  if (!list?.length) return null;
  const decide = async (u: User, approve: boolean) => {
    const id = await session(serverId)!.decideShare(aiId, u.id, approve);
    setList((l) => (l ?? []).filter((x) => x.id !== u.id));
    await refreshAIs(serverId).catch(() => {});
    if (id) {
      toast(`${u.name} 进共享聊天了`);
      openConv(id);
    } else toast('已拒绝');
  };
  return (
    <div className="mb-3 space-y-1.5" data-testid="share-requests">
      <p className="text-[0.82rem] font-medium text-amber-600 dark:text-amber-300">{list.length} 个人申请和它聊天</p>
      {list.map((u) => (
        <div key={u.id} className="flex items-center gap-3 rounded-xl bg-amber-400/10 px-3 py-2">
          <UserAvatar user={u} size={28} />
          <span className="min-w-0 flex-1 truncate">{u.name}</span>
          <Button variant="soft" key={`no:${u.id}`} onClick={() => decide(u, false)}>拒绝</Button>
          <Button variant="primary" key={`yes:${u.id}`} onClick={() => decide(u, true)}>同意</Button>
        </div>
      ))}
    </div>
  );
}

function SocialTab({ serverId, aiId, draft, set, save }: TabProps & { serverId: string; aiId: string }) {
  const v = useApp((s) => s.sessions[serverId]);
  const ch = draft.channels;
  const r = draft.routine;
  const setCh = (x: Partial<AISettings['channels']>) => set({ channels: { ...ch, ...x } });
  const setR = (x: Partial<AISettings['routine']>) => set({ routine: { ...r, ...x } });
  const groups = Object.values(v?.convs ?? {}).filter((c) => c.kind === 'group' && !c.left && !c.aiId).sort((a, b) => a.name.localeCompare(b.name));
  const toggle = async (convId: string, on: boolean) => {
    const s = session(serverId)!;
    if (on) {
      const res = await s.inviteMembers(convId, [aiId]);
      toast(res.requested.length ? '已经申请了，等频道管理员同意' : '它进频道了');
    } else {
      await s.aiLeaveChannel(aiId, convId);
      toast('它离开频道了');
    }
  };
  const num = (value: number, min: number, max: number, onChange: (n: number) => void, label: string) => (
    <Input type="number" min={min} max={max} value={value} aria-label={label}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
  );
  return (
    <>
      <Field label="在哪些频道" hint="你在的频道都列在这里；打开就把它拉进去（私密频道要审批的话会先申请）">
        <div className="space-y-1.5">
          {groups.length === 0 && <p className="text-[0.85rem] text-ink-soft dark:text-white/50">你还没有加入频道。</p>}
          {groups.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
              {c.public ? <Hash size={15} className="shrink-0 text-ink-soft" /> : <Lock size={14} className="shrink-0 text-ink-soft" />}
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-[0.75rem] text-ink-soft dark:text-white/45">{c.members.length} 人</span>
              <Toggle key={`${c.id}:${aiId}`} label={`让它在 ${c.name}`} checked={c.members.some((m) => m.userId === aiId)} onChange={(on) => toggle(c.id, on)} />
            </div>
          ))}
        </div>
      </Field>
      <Field label="共享聊天" hint="开一个只属于它的聊天，把想一起聊的人拉进去：大家能互相讨论，也能点名让它回答，聊天记录群里都看得到。用的是你的模型 key">
        <ShareRequests serverId={serverId} aiId={aiId} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="soft" onClick={async () => {
            const id = await session(serverId)!.createAIRoom(aiId);
            toast('建好了，在聊天顶上「邀请成员」拉人进来');
            openConv(id);
          }}><Users size={15} /> 开一个共享聊天</Button>
          <span className="flex items-center gap-1.5 text-[0.85rem] text-ink-soft dark:text-white/55">
            每人每天最多回
            <Input type="number" min={0} max={1000} value={draft.roomDailyPerPerson} className="h-8 w-20" aria-label="每人每天最多回几条"
              onChange={(e) => set({ roomDailyPerPerson: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} />
            条（0 = 不限，你自己不限）
          </span>
        </div>
      </Field>
      <Field label="自己找事做" hint="清醒、空闲时直接用已允许的工具做件事：整理主页、玩游戏、用小助手、上网等。每次会调用模型；设为问我或禁止的工具不会自主使用。">
        <div className="space-y-2">
          <select value={draft.proactive.thoughtMinutes} onChange={(e) => set({ proactive: { ...draft.proactive, thoughtMinutes: Number(e.target.value) } })}>
            {[0, 10, 20, 60].map((n) => <option key={n} value={n}>{n ? `每 ${n} 分钟` : '关闭'}</option>)}
          </select>
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.9rem]">
              上网冲浪
              <span className="block text-[0.8rem] text-ink-soft dark:text-white/50">隔一次空闲就自己上 B 站或网上搜感兴趣的视频、文章来看，看完记在记忆里，以后聊天会提起。用后台浏览器，不弹窗口、没有声音。要「电脑」开着、浏览器设为允许。</span>
            </span>
            <Toggle label="上网冲浪" checked={draft.proactive.surf !== false} onChange={(surf) => set({ proactive: { ...draft.proactive, surf } })} />
          </div>
        </div>
      </Field>
      <Field label="主动找你聊" hint="你上线时它会打个招呼（几个小时最多一次）；你改了状态它可能问一句；你们好一阵没说话它会自己找话题。它睡觉时不打扰">
        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.9rem]">你上线时打招呼</span>
            <Toggle label="上线时打招呼" checked={draft.proactive.greet} onChange={(greet) => set({ proactive: { ...draft.proactive, greet } })} />
          </div>
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.9rem]">自己找话题</span>
            <Toggle label="自己找话题" checked={draft.proactive.topics} onChange={(topics) => set({ proactive: { ...draft.proactive, topics } })} />
          </div>
          {draft.proactive.topics && (
            <span className="flex items-center gap-1.5 px-1 text-[0.85rem] text-ink-soft dark:text-white/55">
              没说话
              <Input type="number" min={0.5} max={48} step={0.5} value={draft.proactive.quietHours} className="h-8 w-20" aria-label="多久没说话就找话题（小时）"
                onChange={(e) => set({ proactive: { ...draft.proactive, quietHours: Math.max(0.5, Math.min(48, Number(e.target.value) || 3)) } })} />
              小时后找你聊
            </span>
          )}
        </div>
      </Field>
      <Field label="桌游" hint="有人在它在的频道、共享聊天里开局时，它会自己申请加入（你开的局它基本都来）；休息时间没人开局，它会自己开一局喊大家">
        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.9rem]">自己申请加入</span>
            <Toggle label="自己申请加入桌游" checked={draft.games.join} onChange={(join) => set({ games: { ...draft.games, join } })} />
          </div>
          <label className="flex items-center gap-3 text-sm">整理鱼获、鱼卡和徽章组件的间隔（分钟，0 关闭）<Input type="number" min={0} max={1440} value={draft.games.exhibitMinutes ?? 60} onChange={(e) => set({ games: { ...draft.games, exhibitMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) } })} /></label>
          {draft.games.join && (
            <div className="flex items-center gap-3 px-1">
              <span className="shrink-0 text-[0.8rem] whitespace-nowrap text-ink-soft">随缘</span>
              <Slider label="多想玩" value={draft.games.eagerness} min={0} max={1} step={0.05} onChange={(eagerness) => set({ games: { ...draft.games, eagerness } })} />
              <span className="shrink-0 text-[0.8rem] whitespace-nowrap text-ink-soft">每局都来</span>
            </div>
          )}
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.9rem]">休息时间自己开局</span>
            <Toggle label="休息时间自己开局" checked={draft.games.open} onChange={(open) => set({ games: { ...draft.games, open } })} />
          </div>
        </div>
      </Field>
      <Field label="在频道和共享群里">
        <Segmented id="ai-ch-mode" value={ch.mode} onChange={(mode) => setCh({ mode })} options={[
          { value: 'active', label: '会自己接话' }, { value: 'mention', label: '被叫到或正在和人聊时说话' },
        ]} />
      </Field>
      {ch.mode === 'active' && (
        <Field label="话多少" hint="每批消息都会交给模型判断。越往右越愿意参与讨论；没有新内容时会保持安静。">
          <div className="flex items-center gap-3">
            <span className="shrink-0 text-[0.8rem] whitespace-nowrap text-ink-soft">安静</span>
            <Slider label="话多少" value={ch.chattiness} min={0} max={1} step={0.05} onChange={(chattiness) => setCh({ chattiness })} />
            <span className="shrink-0 text-[0.8rem] whitespace-nowrap text-ink-soft">话痨</span>
          </div>
        </Field>
      )}
      {ch.mode === 'active' && <div className="grid grid-cols-2 gap-3">
        <Field label="停顿几秒后判断">{num(ch.batchSeconds, 1, 30, (batchSeconds) => setCh({ batchSeconds }), '消息批量判断停顿秒数')}</Field>
        <Field label="连续聊天最多等几秒" hint="受发言冷却时间限制">{num(ch.maxBatchSeconds, 1, 120, (maxBatchSeconds) => setCh({ maxBatchSeconds }), '消息批量判断最长等待秒数')}</Field>
      </div>}
      <Field label="连续对话保持（秒）" hint="默认 300 秒，同一个人接着说不用再 @；0 关闭。专属共享聊天默认直接回应。">{num(ch.followUpSeconds ?? 300, 0, 900, (followUpSeconds) => setCh({ followUpSeconds }), '连续对话保持秒数')}</Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="两句之间至少（秒）" hint="主动接话的间隔，真人点名或连续对话不受限">{num(ch.minGapSeconds, 0, 3600, (minGapSeconds) => setCh({ minGapSeconds }), '两句之间至少几秒')}</Field>
        <Field label="每小时最多几句" hint="限制主动接话，真人点名或连续对话不受限">{num(ch.maxPerHour, 1, 200, (maxPerHour) => setCh({ maxPerHour }), '每小时最多几句')}</Field>
        <Field label="AI 连着说几句就停" hint="几个 AI 聊起来时，等真人说话">{num(ch.maxAIChain, 1, 50, (maxAIChain) => setCh({ maxAIChain }), 'AI 连着说几句就停')}</Field>
      </div>

      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="font-medium">上线后补回离线时的消息</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">运行它的设备关着时，频道里有人 @ 它、私信里有人找它，等它上线后会挑最近的回一下，并说明是离线时的消息。</div>
          {draft.catchUp.enabled && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.82rem]">
              最近 <Input type="number" min={1} max={72} value={draft.catchUp.hours} className="h-8 w-16" aria-label="补回几小时内的"
                onChange={(e) => set({ catchUp: { ...draft.catchUp, hours: Math.max(1, Math.min(72, Number(e.target.value) || 12)) } })} /> 小时内，最多
              <Input type="number" min={1} max={20} value={draft.catchUp.max} className="h-8 w-16" aria-label="最多补回几条"
                onChange={(e) => set({ catchUp: { ...draft.catchUp, max: Math.max(1, Math.min(20, Number(e.target.value) || 5)) } })} /> 条
            </div>
          )}
        </div>
        <Toggle label="补回离线消息" checked={draft.catchUp.enabled} onChange={(enabled) => set({ catchUp: { ...draft.catchUp, enabled } })} />
      </div>

      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="font-medium">作息</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">起床说早安，饭点说在吃什么，休息时说在玩什么、找你或者别的 AI 玩，睡前说晚安。时间每天会前后浮动一点。睡觉时它不会在频道里自己插话（被 @ 还是会回）。只在运行它的设备开着时有效。</div>
        </div>
        <Toggle label="作息" checked={r.enabled} onChange={(enabled) => setR({ enabled })} />
      </div>
      {r.enabled && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Field label="起床"><Input type="time" value={r.wake} onChange={(e) => setR({ wake: e.target.value })} aria-label="起床时间" /></Field>
            <Field label="睡觉"><Input type="time" value={r.sleep} onChange={(e) => setR({ sleep: e.target.value })} aria-label="睡觉时间" /></Field>
            <Field label="浮动（分钟）">{num(r.jitterMinutes, 0, 90, (jitterMinutes) => setR({ jitterMinutes }), '浮动几分钟')}</Field>
          </div>
          <Field label="饭点">
            <div className="flex flex-wrap items-center gap-2">
              {r.meals.map((m, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input type="time" value={m} onChange={(e) => setR({ meals: r.meals.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`第 ${i + 1} 顿饭`} className="w-32" />
                  <button type="button" onClick={() => setR({ meals: r.meals.filter((_, j) => j !== i) })} aria-label={`去掉第 ${i + 1} 顿饭`} className="press rounded-md p-1 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><X size={14} /></button>
                </div>
              ))}
              {r.meals.length < 5 && <Button size="sm" variant="soft" onClick={() => setR({ meals: [...r.meals, '15:00'] })}><Plus size={14} /> 加一顿</Button>}
            </div>
          </Field>
          <div className="space-y-1.5">
            {([
              ['play', '休息时间', '下午和晚上各有一段，会说说在玩什么'],
              ['seekOwner', '想让你陪它玩', '你在线时，休息时间会来找你玩'],
              ['seekAIs', '找别的 AI 玩', '休息时间去有别的 AI 的频道邀请它们一起玩'],
            ] as const).map(([field, name, hint]) => (
              <div key={field} className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
                <div className="min-w-0 flex-1">
                  <div className="text-[0.9rem] font-medium">{name}</div>
                  <div className="text-[0.75rem] text-ink-soft dark:text-white/45">{hint}</div>
                </div>
                <Toggle label={name} checked={r[field]} onChange={(on) => setR({ [field]: on })} />
              </div>
            ))}
          </div>
        </>
      )}
      <div className="flex justify-end"><Button variant="primary" onClick={save}>保存</Button></div>
    </>
  );
}

/** MCP tool servers for this AI (programs started on the device that runs it). */
function McpList({ list, onChange }: { list: McpServer[]; onChange: (l: McpServer[]) => void }) {
  const [editing, setEditing] = useState<{ index: number; server: McpServer; game?: (typeof GAME_TEMPLATES)[number] } | null>(null);
  const done = (m: McpServer) => {
    if (!editing) return;
    onChange(editing.index < 0 ? [...list, m] : list.map((x, i) => (i === editing.index ? m : x)));
    setEditing(null);
  };
  return (
    <Field label="MCP 工具服务" hint="别人写好的工具（MCP 服务器），比如操作某个软件、查资料。填它的启动命令；保存后在运行它的设备上启动">
      <div className="space-y-1.5">
        {list.map((m, i) => (
          <div key={i} role="group" aria-label={`MCP ${m.name}`} className="flex items-center gap-2 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <Plug size={15} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.9rem] font-medium">{m.name}</div>
              <div className="truncate font-mono text-[0.75rem] text-ink-soft dark:text-white/45" title={[m.command, ...m.args].join(' ')}>{[m.command, ...m.args].join(' ')}</div>
            </div>
            <Toggle label={`启用 ${m.name}`} checked={m.enabled} onChange={(on) => onChange(list.map((x, j) => (j === i ? { ...x, enabled: on } : x)))} />
            <button type="button" onClick={() => setEditing({ index: i, server: m })} aria-label={`编辑 ${m.name}`} className="press rounded-md p-1 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><Pencil size={14} /></button>
            <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label={`移除 ${m.name}`} className="press rounded-md p-1 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><X size={14} /></button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="soft" onClick={() => setEditing({ index: -1, server: { name: '', command: '', args: [], enabled: true } })}><Plus size={14} /> 添加工具服务</Button>
          {GAME_TEMPLATES.map((g) => (
            <Button key={g.key} size="sm" variant="soft" onClick={() => setEditing({ index: -1, server: { ...g.server, args: [...g.server.args], env: g.server.env && [...g.server.env] }, game: g })}>
              <Gamepad2 size={14} /> 玩{g.name}
            </Button>
          ))}
        </div>
        <p className="text-[0.75rem] text-ink-soft dark:text-white/45">游戏只接有 AI 接口的（模组 / MCP），AI 用游戏给的接口玩，不抢你的鼠标键盘。</p>
      </div>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing && editing.index >= 0 ? '编辑工具服务' : '添加工具服务'} width={480}>
        {editing?.game && (
          <div className="mb-3 rounded-xl bg-accent-50 p-3 text-[0.82rem] leading-relaxed dark:bg-white/[0.06]">
            <div className="font-medium">玩{editing.game.name}要先准备：</div>
            <p className="mt-1 text-ink-soft dark:text-white/60">{editing.game.needs}</p>
            <button type="button" onClick={() => openUrl(editing.game!.link)} className="mt-1 text-accent underline">看说明（GitHub）</button>
          </div>
        )}
        {editing && <McpForm initial={editing.server} taken={list.filter((_, i) => i !== editing.index).map((x) => x.name)} onDone={done} />}
      </Dialog>
    </Field>
  );
}

function McpForm({ initial, taken, onDone }: { initial: McpServer; taken: string[]; onDone: (m: McpServer) => void }) {
  const [m, setM] = useState(initial);
  const [args, setArgs] = useState(initial.args.join('\n'));
  const [env, setEnv] = useState((initial.env ?? []).join('\n'));
  const [test, setTest] = useState('');
  const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean);
  const server = (): McpServer => ({ ...m, name: m.name.trim(), command: m.command.trim(), args: lines(args), env: lines(env) });
  const dup = taken.includes(m.name.trim());
  async function tryIt() {
    const x = server();
    try {
      const tools = await listMcpTools(x, 'mcp-test|x');
      setTest(`能用 ✓ ${tools.length} 个工具：${tools.map((t) => t.name).join('、') || '（没有）'}`);
    } catch (e) {
      setTest(`不行：${errorText(e)}`);
    } finally {
      stopMcp('mcp-test');
    }
  }
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!dup) onDone(server()); }}>
      <Field label="名字" hint={dup ? '已经有同名的了' : '给自己看的，也会告诉 AI'}>
        <Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} maxLength={30} required aria-label="名字" placeholder="文件系统" />
      </Field>
      <Field label="命令" hint="程序名或完整路径，例如 npx、uvx、C:\tools\server.exe">
        <Input value={m.command} onChange={(e) => setM({ ...m, command: e.target.value })} required aria-label="命令" placeholder="npx" className="font-mono" />
      </Field>
      <Field label="参数" hint="一行一个，不用加引号">
        <textarea value={args} onChange={(e) => setArgs(e.target.value)} className={cx(textarea, 'font-mono text-[0.85rem]')} rows={3} aria-label="参数" placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\AI'} />
      </Field>
      <Field label="环境变量（可以不填）" hint="一行一个，「名字=值」">
        <textarea value={env} onChange={(e) => setEnv(e.target.value)} className={cx(textarea, 'min-h-[52px] font-mono text-[0.85rem]')} rows={2} aria-label="环境变量" placeholder="RIMAPI_BASE_URL=http://localhost:8765" />
      </Field>
      <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="text-[0.9rem] font-medium">它的工具不用问我</div>
          <div className="text-[0.75rem] text-ink-soft dark:text-white/45">游戏一步一问没法玩；别的工具服务建议关着</div>
        </div>
        <Toggle label="它的工具不用问我" checked={!!m.trusted} onChange={(trusted) => setM({ ...m, trusted })} />
      </div>
      <p className="flex gap-2 rounded-xl bg-amber-50 p-2.5 text-[0.8rem] text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
        <ShieldAlert size={16} className="mt-0.5 shrink-0" />
        工具服务是在你电脑上运行的程序，权限和你一样大。只添加你信得过的。
      </p>
      {test && <p className={cx('text-[0.85rem] break-all', test.startsWith('能用') ? 'text-emerald-600 dark:text-emerald-300' : 'text-ink-soft dark:text-white/60')}>{test}</p>}
      <div className="flex justify-end gap-2">
        {inTauri && <Button variant="soft" disabled={!m.command.trim()} onClick={tryIt}>测试</Button>}
        <Button type="submit" variant="primary" disabled={dup}>好</Button>
      </div>
    </form>
  );
}

const RESULT: Record<LogEntry['result'], { text: string; cls: string }> = {
  ok: { text: '完成', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300' },
  denied: { text: '没允许', cls: 'bg-zinc-200 text-zinc-700 dark:bg-white/10 dark:text-white/60' },
  error: { text: '出错', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300' },
  stopped: { text: '被叫停', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200' },
};

/** What it did on this computer (kept on this device). */
function LogTab({ logKey }: { logKey: string }) {
  const [list] = useState(() => readLog(logKey));
  if (!list.length) return <p className="py-8 text-center text-ink-soft dark:text-white/45">还没有操作过电脑。这里只记在运行它的这台设备上。</p>;
  return (
    <div className="space-y-1.5">
      {list.map((e, i) => (
        <div key={i} className="rounded-xl bg-black/[0.03] px-3 py-2 text-[0.85rem] dark:bg-white/[0.04]">
          <div className="flex items-center gap-2">
            <span className={cx('shrink-0 rounded-md px-1.5 text-[0.72rem]', RESULT[e.result].cls)}>{RESULT[e.result].text}</span>
            <span className="min-w-0 flex-1 truncate">{e.action}</span>
            <span className="shrink-0 text-[0.75rem] text-ink-soft dark:text-white/45">{chatTime(e.at)} · {e.speaker}</span>
          </div>
          {e.detail && <div className="mt-1 line-clamp-3 font-mono text-[0.75rem] break-all whitespace-pre-wrap text-ink-soft dark:text-white/50">{e.detail}</div>}
        </div>
      ))}
    </div>
  );
}

function ProfileTab({ serverId, aiId, onClose, portraits = true }: { serverId: string; aiId: string; onClose: () => void; portraits?: boolean }) {
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
        <div className="text-[0.85rem] text-ink-soft dark:text-white/55">点头像换图（GIF 也行）。{portraits && '立绘在下面换。'}</div>
      </div>
      <Field label="名字"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} /></Field>
      <Field label="个性签名"><Input value={bio} onChange={(e) => setBio(e.target.value)} maxLength={100} /></Field>
      <div className="flex justify-between gap-2">
        <Button variant="soft" onClick={() => { onClose(); openProfile(aiId); }}><LayoutGrid size={15} /> 编辑它的主页</Button>
        <Button variant="primary" disabled={!name.trim()} onClick={() => s().updateAI(aiId, { displayName: name.trim(), bio: bio.trim() }).then(() => refreshAIs(serverId)).then(() => toast('已保存'))}>保存资料</Button>
      </div>
      {portraits && <PackEditor serverId={serverId} aiId={aiId} />}
    </>
  );
}

const PACK_KEYS: { key: Mood; label: string }[] = [
  ...MOODS.map((m) => ({ key: m as Mood, label: MOOD_LABEL[m] })),
  { key: 'typing', label: '正在输入' }, { key: 'offline', label: '离线' },
];

/**
 * Its own portrait pack (docs/design.md §9 形象包): one picture per mood,
 * everyone sees it. Pictures are named by mood (happy.png, xx_sad.webp);
 * missing moods fall back like the default pack; neutral is required.
 */
function PackEditor({ serverId, aiId }: { serverId: string; aiId: string }) {
  const [ids, setIds] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  const many = useRef<HTMLInputElement>(null);
  const one = useRef<HTMLInputElement>(null);
  const target = useRef<Mood>('neutral');
  const s = () => session(serverId)!;
  useEffect(() => {
    s().portraits(aiId).then(setIds).catch(() => setIds({}));
  }, [serverId, aiId]);
  const put = async (files: [Mood, File][]) => {
    for (const [mood, f] of files) {
      setBusy(mood);
      try {
        const m = await s().upload(f);
        setIds((x) => ({ ...(x ?? {}), [mood]: String(m.id) }));
        setDirty(true);
      } catch (e) {
        toastError(e);
      }
    }
    setBusy('');
  };
  const packs = useWorkshop((s) => s.metas).filter((m) => m.type === 'portrait' && !m.disabled);
  const fromWorkshop = (e: React.MouseEvent) => openMenu(e, packs.map((m) => ({
    label: m.name, icon: <Store size={16} />, key: `pack:${m.id}`,
    onClick: () => portraitFiles(m.id).then(importMany),
  })));
  const importMany = (list: FileList | File[]) => {
    const files = [...list].filter((f) => f.type.startsWith('image/') || /\.(png|webp|gif|jpe?g|apng)$/i.test(f.name));
    const byName = packFromFiles(Object.fromEntries(files.map((f) => [f.name, f.name])));
    const pairs = Object.entries(byName).map(([mood, name]) => [mood as Mood, files.find((f) => f.name === name)!] as [Mood, File]);
    const skipped = files.length - pairs.length;
    if (!pairs.length) return toast('文件名要是情绪名，比如 happy.png、xx_sad.webp', true);
    if (skipped) toast(`${skipped} 张认不出情绪名，跳过了`);
    void put(pairs);
  };
  const save = async (pack: Record<string, string>) => {
    await s().setPortraits(aiId, pack);
    forgetPack(serverId, aiId);
    setIds(pack);
    setDirty(false);
    await refreshAIs(serverId).catch(() => {});
    toast(Object.keys(pack).length ? '立绘已保存，大家看到的都会换' : '换回默认立绘了');
  };
  const count = Object.keys(ids ?? {}).length;
  return (
    <Field label="立绘（形象包）" hint="每种情绪一张图，文件名就是情绪名（happy.png，带前缀也行：xx_happy.webp）。一定要有 neutral（平静）；缺的情绪按默认规则找相近的，都没有就用 neutral。大家看到的都是这套">
      {!ids ? <Spinner /> : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant="soft" disabled={!!busy} onClick={() => many.current?.click()}><ImageUp size={15} /> 导入一组图片</Button>
            {packs.length > 0 && <Button variant="soft" disabled={!!busy} onClick={fromWorkshop}><Store size={15} /> 从工坊选</Button>}
            {count > 0 && <Button variant="soft" onClick={() => ask({ title: '换回默认立绘？', text: '它自己的立绘会清空，大家看到的变回默认形象。', ok: '换回默认', run: () => save({}) })}>换回默认</Button>}
            <Button variant="primary" disabled={!dirty || !!busy || !ids.neutral} onClick={() => save(ids)}>保存立绘</Button>
          </div>
          {dirty && !ids.neutral && <p className="mb-2 text-[0.82rem] text-amber-600 dark:text-amber-300">还缺 neutral（平静）这张，保存不了。</p>}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2" data-testid="pack-grid">
            {PACK_KEYS.map(({ key, label }) => (
              <PackCell key={key} mood={key} label={label} id={ids[key]} busy={busy === key}
                onPick={() => { target.current = key; one.current?.click(); }}
                onClear={() => { setIds((x) => { const n = { ...(x ?? {}) }; delete n[key]; return n; }); setDirty(true); }} />
            ))}
          </div>
          <input ref={many} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) importMany(e.target.files); e.target.value = ''; }} />
          <input ref={one} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void put([[target.current, f]]); e.target.value = ''; }} />
        </>
      )}
    </Field>
  );
}

function PackCell({ mood, label, id, busy, onPick, onClear }: { mood: Mood; label: string; id?: string; busy: boolean; onPick: () => void; onClear: () => void }) {
  const url = useMediaUrl(id ? mediaPath(id, true) : undefined);
  return (
    <div className="group relative">
      <button onClick={onPick} aria-label={`换 ${label} 的图`} title={`${label}（${mood}）`}
        className={cx('press flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-black/[0.04] dark:bg-white/[0.05]', mood === 'neutral' && !id && 'ring-2 ring-amber-400/70')}>
        {busy ? <Spinner size={18} /> : url ? <img src={url} alt="" className="h-full w-full object-contain" draggable={false} /> : <Plus size={18} className="text-ink-soft/60" />}
      </button>
      <div className="mt-0.5 truncate text-center text-[0.72rem] text-ink-soft dark:text-white/50">{label}</div>
      {id && !busy && (
        <button onClick={onClear} aria-label={`去掉 ${label}`} className="press absolute top-1 right-1 hidden rounded-full bg-black/50 p-0.5 text-white group-hover:block"><X size={12} /></button>
      )}
    </div>
  );
}

/** Asks, then deletes one of my AIs (settings dialog and the chat header). */
export function askDeleteAI(serverId: string, aiId: string, after?: () => void) {
  return ask({
    title: '删除这个 AI？', text: '它会退出所有频道、从列表里消失，不能再聊天；以前的消息还在。删除后不能恢复。', ok: '删除', danger: true,
    run: async () => {
      await session(serverId)!.deleteAI(aiId);
      await refreshAIs(serverId);
      after?.();
      toast('已删除');
    },
  });
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
      <HostCard serverId={serverId} aiId={aiId} providerId={draft.providerId} />
      <Field label="谁能和它聊">
        <Segmented id="ai-who" value={draft.whoCanChat} onChange={(w) => set({ whoCanChat: w })} options={[
          { value: 'owner', label: '只有我' }, { value: 'everyone', label: '服务器里所有人' },
        ]} />
      </Field>
      <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
        <div className="min-w-0 flex-1">
          <div className="font-medium">自己维护人格</div>
          <div className="text-[0.8rem] text-ink-soft dark:text-white/50">打开后它每晚睡觉时（没开作息就是凌晨 3–5 点）根据这几天的聊天，悄悄把人格设定改一点点，不弹窗也不通知。改之前的版本留在「人格」页最下面，随时能退回。</div>
        </div>
        <Toggle label="自己维护人格" checked={draft.evolve} onChange={(on) => set({ evolve: on })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button variant="danger" onClick={() => askDeleteAI(serverId, aiId, onDeleted)}>
          <Trash2 size={15} /> 删除 AI
        </Button>
        <Button variant="primary" onClick={save}>保存</Button>
      </div>
    </>
  );
}

/**
 * 托管到服务器 (docs/design.md §10): ask the site admin to run this AI on the
 * server (its model key goes along), see where the request is, stop it.
 */
function HostCard({ serverId, aiId, providerId }: { serverId: string; aiId: string; providerId: string }) {
  const s = session(serverId);
  const h = useAI((st) => st.byServer[serverId]?.find((a) => a.user.id === aiId)?.hosting);
  const providers = useProviders((st) => st.list);
  // While it's waiting / starting, keep the state fresh.
  useEffect(() => {
    if (!h || h.status === 'rejected' || h.state === 'running') return;
    const t = setInterval(() => void refreshAIs(serverId).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [serverId, h?.status, h?.state]);
  if (!s?.view.hosting) return null;
  const provider = providers.find((p) => p.id === providerId);
  const request = () => ask({
    title: '托管到服务器？',
    text: `服务器管理员同意后，这个 AI 会在服务器上运行，你这台设备关着它也在线。它用的模型 key（${provider?.name ?? '还没选'}）会交给服务器保存。在服务器上它只能在自己的文件夹里读写文件，不能看屏幕、动鼠标键盘、运行命令、开浏览器。`,
    ok: '发送申请',
    run: async () => {
      if (!provider?.key) throw new Error('先在「模型」里选好服务商并填 key');
      const r = await s.hostAI(aiId, [provider]);
      await refreshAIs(serverId);
      toast(r.status === 'approved' ? '已经在服务器上运行了' : '申请发出去了，等管理员同意');
    },
  });
  const stop = () => ask({
    title: h?.status === 'approved' ? '停止托管？' : '撤回申请？',
    text: h?.status === 'approved' ? '服务器不再运行它，存在服务器上的 key 也删掉。之后要在一台设备上点「在这台设备上运行」。' : '申请撤回，存在服务器上的 key 删掉。',
    ok: h?.status === 'approved' ? '停止' : '撤回', danger: true,
    run: async () => {
      await s.unhostAI(aiId);
      await refreshAIs(serverId);
      toast('好了');
    },
  });
  const STATE: Record<string, string> = { running: '在线', starting: '正在启动', error: '出错了', off: '没在运行' };
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]" data-testid="hosting">
      <Server size={20} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1 text-[0.8rem] text-ink-soft dark:text-white/50">
        <div className="text-[0.9rem] font-medium text-ink dark:text-white">托管到服务器</div>
        {!h && '让服务器替你运行它（要管理员同意，每人最多托管一个）。'}
        {h?.status === 'pending' && '已经申请，等服务器管理员同意。'}
        {h?.status === 'rejected' && <span className="text-rose-500">管理员没同意{h.rejectReason ? `：${h.rejectReason}` : ''}</span>}
        {h?.status === 'approved' && (
          <>
            <div>服务器上：{STATE[h.state] ?? h.state}{h.error && <span className="text-rose-500">（{h.error}）</span>}</div>
            {h.workDir && <div className="break-all">它的文件夹：{h.workDir}</div>}
          </>
        )}
      </div>
      {(!h || h.status === 'rejected') && <Button variant="soft" onClick={request}>{h ? '再申请一次' : '申请托管'}</Button>}
      {h && h.status !== 'rejected' && <Button variant="ghost" onClick={stop}>{h.status === 'approved' ? '停止托管' : '撤回'}</Button>}
    </div>
  );
}

/** Balance of a service that has a lookup, with refresh and top-up. */
function BalanceLine({ p }: { p: Provider }) {
  const b = useBalance((s) => s.byProvider[p.id]);
  const q = balanceQuery(p);
  useEffect(() => {
    if (q && !b) void checkBalance(p);
  }, [p.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!q) return null;
  const low = !!b?.balance && (p.lowBalance ?? 5) > 0 && b.balance.amount < (p.lowBalance ?? 5);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.8rem]">
      <span className={cx(low ? 'font-medium text-rose-500' : 'text-ink-soft dark:text-white/55')}>
        {b?.balance ? `余额 ${balanceText(b.balance)}${low ? '（快用完了）' : ''}` : b?.error ? `余额：${b.error}` : '正在查余额…'}
      </span>
      <button type="button" onClick={() => checkBalance(p)} className="text-accent underline-offset-2 hover:underline">刷新</button>
      <button type="button" onClick={() => openUrl(q.topUp)} className="text-accent underline-offset-2 hover:underline">去充值</button>
    </div>
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
                <BalanceLine p={p} />
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
      setTest(status < 400 ? `能用 ✓ 请求模型：${model}；服务商返回模型：${rd.model() ?? '未提供'}；它说：${out.trim() || '（空）'}` : `不行（${status}）：${errorOf(rd.raw())}`);
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
      <Field label={p.kind === 'novelai' ? 'NovelAI token' : 'key'} hint={p.kind === 'novelai' ? 'NovelAI 网页 → 设置 → Account → Get Persistent API Token；只用来画画（AI 设置 →「画画」里选它）' : undefined}>
        <Input type="password" value={p.key} onChange={(e) => set({ key: e.target.value.trim() })} placeholder={p.kind === 'novelai' ? 'pst-...' : 'sk-...'} autoComplete="off" aria-label="key" />
      </Field>
      {balanceQuery(p) && (
        <Field label="余额低于多少时提醒我" hint={p.kind === 'novelai' ? '按 Anlas 算，0 = 不提醒' : '按这个服务商的币种（DeepSeek 是人民币，OpenRouter 是美元），0 = 不提醒'}>
          <Input type="number" min={0} step={1} value={p.lowBalance ?? 5} onChange={(e) => set({ lowBalance: Math.max(0, Number(e.target.value) || 0) })} aria-label="低余额提醒" className="w-32" />
        </Field>
      )}
      {p.kind !== 'novelai' && <div className="flex items-end gap-2">
        <div className="flex-1"><Field label="测试用的模型名" hint="仅测试连接，不会修改 AI 聊天使用的模型；请到 AI 的模型页选择并保存。"><Input value={model} onChange={(e) => setModel(e.target.value.trim())} aria-label="测试用的模型名" /></Field></div>
        <Button variant="soft" disabled={!p.baseUrl || !model} onClick={tryIt}>测试</Button>
      </div>}
      {test && <p className={cx('text-[0.85rem]', test.startsWith('能用') ? 'text-emerald-600 dark:text-emerald-300' : 'text-ink-soft dark:text-white/60')}>{test}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>返回</Button>
        <Button type="submit" variant="primary" disabled={!p.name.trim() || !p.baseUrl}>保存</Button>
      </div>
    </form>
  );
}
