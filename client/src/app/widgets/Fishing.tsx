import { useEffect, useState } from 'react';
import { current, session } from '@/lib/store';
import type { WidgetModel } from '@/lib/widgets';
import { CARD_RARITY, collectionProgress, exhibitCapacity, type Collection, type FishingRules } from '@/lib/fishing';
import { FishArt, FishCard, FishingBadge } from '../Fishing';
import type { WidgetCtx } from './Kinds';

const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
export function FishingWidget({ w, ctx }: { w: WidgetModel; ctx: WidgetCtx }) {
  const [rules, setRules] = useState<FishingRules>(); const [data, setData] = useState<Collection>(); const [error, setError] = useState('');
  useEffect(() => {
    let live = true; const s = session(ctx.v.id); if (!s || ctx.target === 'server') return;
    void Promise.all([s.fishingRules(), s.fishingShowcase(ctx.target)]).then(([r, d]) => { if (live) { setRules(r); setData(d); setError(''); } }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [ctx.v.id, ctx.target]);
  if (error) return <div className="p-3 text-xs text-ink-soft">钓鱼展示暂不可用：{error}</div>;
  if (!rules || !data) return <div className="p-3 text-xs text-ink-soft">正在看鱼塘收藏…</div>;
  const ids = strings(w.config.ids).slice(0, exhibitCapacity(w.kind, w.w, w.h));
  if (w.kind === 'fishing_badges') return <div className="grid h-full grid-cols-2 gap-1 overflow-auto p-2">{data.badges.some((n) => n > 0) ? data.badges.flatMap((n, tier) => Array.from({ length: n }, (_, i) => <FishingBadge key={`${tier}:${i}`} tier={tier} level={i + 1} />)) : <div className="col-span-2 self-center text-center text-xs text-ink-soft">收藏满 25 种同档鱼卡，就能得到第一枚徽章。</div>}</div>;
  if (w.kind === 'fishing_cards' && w.config.mode === 'progress') return <div className="flex h-full flex-col justify-center gap-1.5 overflow-auto p-3">{collectionProgress(data).map((n, i) => <div key={i}><div className="flex justify-between text-xs"><span>{CARD_RARITY[i]}</span><span>{n}/100</span></div><progress className="h-1.5 w-full accent-cyan-600" value={n} max={100} /></div>)}</div>;
  if (!ids.length) return <div className="flex h-full items-center justify-center p-3 text-center text-xs text-ink-soft">编辑小组件，挑选你的{w.kind === 'fishing_fish' ? '鱼' : '鱼卡'}。</div>;
  const verticalFish = w.w > w.h;
  const capacity = exhibitCapacity(w.kind, w.w, w.h);
  const cols = w.kind === 'fishing_fish' ? Math.min(capacity || 1, verticalFish ? w.w : Math.max(1, Math.floor(w.w / 2))) : w.w;
  const rows = Math.max(1, Math.ceil(capacity / cols));
  return <div className="fishing-exhibit grid h-full gap-1 overflow-hidden p-2" style={{ gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gridTemplateRows: `repeat(${rows},minmax(0,1fr))` }}>
    {ids.map((id) => {
      if (w.kind === 'fishing_cards') return data.cards[id] > 0 ? <FishCard key={id} card={id} rules={rules} /> : <div key={id} className="text-xs text-ink-soft">未收集</div>;
      const f = data.records[id]; const species = rules.catalog.find((x) => x.id === f?.species);
      return f ? <div key={id} className="flex min-h-0 flex-col rounded-xl bg-cyan-100/30 p-1 text-center dark:bg-cyan-900/20" title={`${species?.name} · ${f.length_cm} cm · ${id.endsWith(':min') ? '最短' : '最长'}纪录`}><div className="min-h-0 flex-1"><FishArt fish={species} vertical={verticalFish} /></div><span className="truncate text-[10px]">{species?.name}</span><span className="text-[10px] text-ink-soft">{f.length_cm} cm</span></div> : <div key={id} className="text-xs text-ink-soft">暂无纪录</div>;
    })}
  </div>;
}

export function FishingConfig({ kind, cfg, set, capacity }: { kind: string; cfg: Record<string, unknown>; set: (patch: Record<string, unknown>) => void; capacity: number }) {
  const [data, setData] = useState<Collection>(); const [rules, setRules] = useState<FishingRules>(); const [error, setError] = useState('');
  useEffect(() => {
    let live = true; const s = current(); if (!s.view.me) return;
    void Promise.all([s.fishingRules(), s.fishingShowcase(s.view.me.id)]).then(([r, d]) => { if (live) { setData(d); setRules(r); } }).catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  if (kind === 'fishing_badges') return <p className="text-sm text-ink-soft">自动展示已获得的所有收藏徽章。铁、铜、银、金、镭射，每档收集 25%、50%、75%、100% 解锁四级徽章。</p>;
  const ids = strings(cfg.ids); const card = kind === 'fishing_cards';
  const options = data && rules ? (card ? Object.keys(data.cards).filter((k) => data.cards[k] > 0).sort().map((id) => { const [tier, species] = id.split(':'); return { id, text: `${CARD_RARITY[Number(tier)]} · ${rules.catalog.find((s) => s.id === species)?.name}` }; }) : Object.entries(data.records).sort(([a], [b]) => a.localeCompare(b)).map(([id, f]) => ({ id, text: `${rules.catalog.find((s) => s.id === f.species)?.name} · ${id.endsWith(':min') ? '最短' : '最长'} ${f.length_cm} cm` }))) : [];
  return <div className="space-y-3">
    {card && <label className="block text-sm">展示方式<select className="ml-2 rounded border bg-transparent p-2" value={String(cfg.mode ?? 'cards')} onChange={(e) => set({ mode: e.target.value })}><option value="cards">选择鱼卡</option><option value="progress">五档收集进度</option></select></label>}
    {(!card || cfg.mode !== 'progress') && <><p className="text-xs text-ink-soft">{card ? '每格一张卡。' : '每两格一条鱼，横宽时竖放，纵长时横放。展示自己钓获的最短 / 最长纪录，卖鱼不会移除，破纪录会自动更新。'} 已选 {ids.length}/{capacity}</p><div className="max-h-56 space-y-1 overflow-auto">{options.map((o) => <label key={o.id} className="flex items-center gap-2 rounded-lg bg-black/5 p-2 text-sm dark:bg-white/5"><input type="checkbox" checked={ids.includes(o.id)} disabled={!ids.includes(o.id) && ids.length >= capacity} onChange={(e) => set({ ids: e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id) })} className="accent-cyan-700" />{o.text}</label>)}{!options.length && <p className="text-xs text-ink-soft">{error || '还没有可展示的收藏，先去钓鱼吧。'}</p>}</div></>}
  </div>;
}
