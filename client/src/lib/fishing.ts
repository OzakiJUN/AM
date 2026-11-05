// Server-owned fishing economy and public catalogue (docs/fishing.md).
export interface Species { id: string; name: string; rarity: number; average_m: number; base_value: number; colour: string; shape: string; motif: number; description: string }
export interface Specimen { base_value?: number; acquired_at?: number; steal_bonus_percent?: number; id: string; species: string; average_m?: number; length_m: number; owner_key?: string; value: number; caught_by: string; at: number }
export interface Angler { user_id: string; bite_at: number; expires_at: number }
export interface Pond { catching_up?: boolean; seats: Angler[]; now: number }
export interface Collection { records: Record<string, Specimen>; cards: Record<string, number>; badges: number[] }
export interface FishingAccount extends Collection { version: number; identity: string; local_slot: string; revision: number; frozen: boolean; transfer_id: string; transfer_to: string; coins: number; fish: Specimen[] | null; packs: number; tools: Record<string, number>; equipped: string[] | null; auto_at: number; steal_at: number; ward_at: number; room: string; last: string; opened: string[] | null }
export interface FishingRules { version: number; catalog: Species[]; wait_min_seconds: number; wait_max_seconds: number; bite_seconds: number; start_coins: number; pack_price: number; inventory_limit: number; pack_limit: number; fish_weights: number[]; length_sigma: number; length_value_scale: number; worker_ms: number; catchup_batch: number; auto_steal_delay_ms: number; ward_block_percent: number[]; glove_pierce_percent: number[]; card_weights: number[]; loot_weights: number[]; money_min: number; money_max: number; tool_prices: number[]; speed_percent: number[]; double_fish_percent?: number[]; value_percent: number[]; steal_base_cd_seconds?: number; steal_fish_count?: number[]; steal_cd_reduction_percent?: number[]; steal_value_percent?: number[]; steal_cd_seconds: number[]; steal_percent: number[]; ward_cd_seconds: number[] }
export interface FishingAction { action: 'sell' | 'buy_tool' | 'equip' | 'unequip' | 'buy_pack' | 'open_pack'; item?: string; quality?: number; fishIds?: string[] }
export const FISH_RARITY = ['常见', '奇异', '稀有', '史诗', '传说'];
export const CARD_RARITY = ['铁', '铜', '银', '金', '镭射'];
export const QUALITY = ['朴素', '精良', '稀有', '史诗', '传说'];
export const TOOLS = { speed: '疾风钓竿', auto: '双鱼钓竿', value: '点金钓竿', glove: '多鱼手套', glove_haste: '疾影手套', glove_value: '点金手套', ward: '守鱼结界' };
export type Tool = keyof typeof TOOLS;
export const TOOL_KEYS = Object.keys(TOOLS) as Tool[];
export const isGlove = (k?: string) => k === 'glove' || k === 'glove_haste' || k === 'glove_value';
export function gloveStats(r: FishingRules, a: FishingAccount) {
 const q = (k: string) => a.equipped?.includes(k) ? a.tools[k] ?? 0 : 0;
 const quality = Math.max(q('glove'),q('glove_haste'),q('glove_value'));
 const reduction = q('glove_haste') ? r.steal_cd_reduction_percent?.[q('glove_haste')-1] ?? 0 : 0;
 return { equipped: quality > 0, count: q('glove') ? r.steal_fish_count?.[q('glove')-1] ?? 1 : 1,
  cooldown: r.steal_base_cd_seconds ? Math.max(1,Math.floor(r.steal_base_cd_seconds*(100-reduction)/100)) : r.steal_cd_seconds[Math.max(0,quality-1)],
  bonus: q('glove_value') ? r.steal_value_percent?.[q('glove_value')-1] ?? 0 : 0 };
}
export function toolEffect(r: FishingRules, k: Tool, q: number) {
 const i=q-1;
 if (k==='speed') return `等待缩短 ${r.speed_percent[i]}%`;
 if (k==='auto') return r.double_fish_percent ? `一次钓两条鱼的概率 ${r.double_fish_percent[i]}%` : '服务端尚未升级双鱼规则';
 if (k==='value') return `自己钓到的鱼价值增加 ${r.value_percent[i]}%`;
 if (isGlove(k)) {
  const effect = k==='glove' ? `每次最多偷 ${r.steal_fish_count?.[i] ?? 1} 条鱼` : k==='glove_haste' ? `偷鱼冷却缩短 ${r.steal_cd_reduction_percent?.[i] ?? 0}%` : `偷来的鱼售价增加 ${r.steal_value_percent?.[i] ?? 0}%`;
  return `${effect}；成功率 ${r.steal_percent[i]}%，破盾 ${r.glove_pierce_percent[i]}%；手套共用冷却`;
 }
 return `自动防偷 ${r.ward_block_percent[i]}%，冷却 ${r.ward_cd_seconds[i]} 秒`;
}
export function cardParts(key: string): [number, string] { const [tier, id] = key.split(':'); return [Number(tier), id]; }
export function collectionProgress(c: Collection): number[] { return CARD_RARITY.map((_, tier) => Object.entries(c.cards).filter(([key, n]) => key.startsWith(`${tier}:`) && n > 0).length); }
export function recordsOf(c: Collection): Specimen[] { return [...new Map(Object.values(c.records).map((f) => [f.id, f])).values()]; }
export function exhibitCapacity(kind: string, w: number, h: number) { return kind === 'fishing_fish' ? Math.floor(w * h / 2) : w * h; }
export function isBiting(p: Angler, now: number) { return p.user_id !== '0' && now >= p.bite_at && now <= p.expires_at; }

export const FISHING_ACCOUNT_EVENT = 'am-fishing-account';

export const moneyText = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function ownFish(a: FishingAccount, id: string): Specimen[] { return (a.fish ?? []).filter((f) => f.owner_key ? f.owner_key === a.identity : f.caught_by === id); }
export function fishInfo(f: Specimen, s?: Species): string {
 const standard=f.average_m || s?.average_m;
 return [s?.name ?? f.species, FISH_RARITY[s?.rarity ?? 0], `标准长度 ${standard?.toFixed(2) ?? '?'} m`, `实际长度 ${f.length_m.toFixed(2)} m`, `偏差 ${standard ? ((f.length_m / standard - 1) * 100).toFixed(2) : '?'}%`, `价值 ${moneyText(f.value)} 金币`, ...(f.steal_bonus_percent ? [`含偷鱼售价加成 ${f.steal_bonus_percent}%`] : []), `钓获时间 ${new Date(f.at).toLocaleString()}`].join('\n');
}
