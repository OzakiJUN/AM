// The 画画 tab of an AI's settings (docs/design.md §9 画画): its NovelAI
// account, who may ask it to draw, adult content in DMs, a proxy, and the
// drawing defaults. The commands and the tool: lib/ai/naiRun.ts.
import { Palette } from 'lucide-react';
import type { AISettings } from '@/lib/ai/persona';
import { useProviders } from '@/lib/ai/keys';
import { usage, type DrawSettings } from '@/lib/ai/nai';
import { Button, Field, Input, Segmented, Toggle, cx, inputClass } from '@/ui';

type Props = { draft: AISettings; set: (p: Partial<AISettings>) => void; save: () => Promise<void> };

const num = (v: string, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};

export function DrawTab({ draft, set, save }: Props) {
  const d = draft.draw;
  const setD = (x: Partial<DrawSettings>) => set({ draw: { ...d, ...x } });
  const nai = useProviders((s) => s.list).filter((p) => p.kind === 'novelai');
  return (
    <>
      <div className="card flex items-start gap-3 rounded-2xl p-4 text-[0.85rem]">
        <Palette size={20} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1 text-ink-soft dark:text-white/60">
          <div className="font-semibold text-ink dark:text-white">用 NovelAI 画画</div>
          接好以后，大家发 <code>/nai 描述</code>、<code>/nai5 描述</code> 它就画；跟它说「给我画个……」它也会自己写提示词去画。Opus 订阅单张普通尺寸不扣 Anlas。
        </div>
      </div>
      <Field label="NovelAI 账号" hint={nai.length ? undefined : '先在「模型」→「管理服务商」里加一个「NovelAI（画画）」，key 填 NovelAI 网页 → 设置 → Account → Get Persistent API Token 的那串'}>
        <select value={d.providerId} onChange={(e) => setD({ providerId: e.target.value })} className={cx(inputClass, 'h-11')} aria-label="NovelAI 账号">
          <option value="">（不画画）</option>
          {nai.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      {d.providerId && (
        <>
          <Field label="谁能叫它画">
            <Segmented id="draw-who" value={d.who} onChange={(who) => setD({ who })} options={[{ value: 'owner', label: '只有我' }, { value: 'everyone', label: '能跟它聊的人都行' }]} />
          </Field>
          {d.who === 'everyone' && (
            <Field label="别人每天最多画几次" hint="0 = 不限；你自己不限">
              <Input type="number" min={0} value={d.dailyPerPerson} onChange={(e) => setD({ dailyPerPerson: num(e.target.value, 0, 1000, 20) })} />
            </Field>
          )}
          <div className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
            <div className="min-w-0 flex-1">
              <div className="font-medium">私信里允许 NSFW</div>
              <div className="text-[0.8rem] text-ink-soft dark:text-white/50">频道里看频道设置的「允许 NSFW」。涉及未成年的永远不画。</div>
            </div>
            <Toggle label="私信里允许 NSFW" checked={d.nsfwInDM} onChange={(nsfwInDM) => setD({ nsfwInDM })} />
          </div>
          <Field label="代理" hint="国内连不上 NovelAI 时填，例如 http://127.0.0.1:7890；不填就直连">
            <Input value={d.proxy} onChange={(e) => setD({ proxy: e.target.value.trim() })} placeholder="http://127.0.0.1:7890" />
          </Field>
          <details className="rounded-2xl bg-black/[0.03] p-4 dark:bg-white/[0.04]">
            <summary className="cursor-pointer font-medium">更多设置</summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <Field label="一次最多几张"><Input type="number" min={1} max={16} value={d.maxCount} onChange={(e) => setD({ maxCount: num(e.target.value, 1, 16, 8) })} /></Field>
                <Field label="步数" hint="超过 28 扣 Anlas"><Input type="number" min={1} max={50} value={d.steps} onChange={(e) => setD({ steps: num(e.target.value, 1, 50, 28) })} /></Field>
                <Field label="CFG"><Input type="number" step={0.5} min={0} max={10} value={d.scale} onChange={(e) => setD({ scale: num(e.target.value, 0, 10, 5) })} /></Field>
              </div>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 text-[0.85rem]">/nai5 直接用中文（不翻译）</div>
                <Toggle label="nai5 直接用中文" checked={d.v5Native} onChange={(v5Native) => setD({ v5Native })} />
              </div>
              <Field label="质量词（V4.5）"><Input value={d.quality} onChange={(e) => setD({ quality: e.target.value })} /></Field>
              <Field label="质量词（V5）"><Input value={d.qualityV5} onChange={(e) => setD({ qualityV5: e.target.value })} /></Field>
              <Field label="负面提示词"><textarea className={cx(inputClass, 'min-h-[72px] resize-y py-2 text-[0.8rem]')} value={d.negative} onChange={(e) => setD({ negative: e.target.value })} aria-label="负面提示词" /></Field>
              <Field label="屏蔽词" hint="逗号分开；写到就不画，英文的也加进负面提示词">
                <Input value={d.blockWords.join('，')} onChange={(e) => setD({ blockWords: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="V4.5 模型"><Input value={d.model} onChange={(e) => setD({ model: e.target.value.trim() })} /></Field>
                <Field label="V5 模型"><Input value={d.v5Model} onChange={(e) => setD({ v5Model: e.target.value.trim() })} /></Field>
              </div>
            </div>
          </details>
          <pre className="whitespace-pre-wrap rounded-xl bg-black/[0.03] p-3 text-[0.78rem] leading-relaxed text-ink-soft dark:bg-white/5 dark:text-white/60">{usage('draw', d.maxCount)}</pre>
        </>
      )}
      <div className="flex justify-end"><Button variant="primary" onClick={save}>保存</Button></div>
    </>
  );
}
