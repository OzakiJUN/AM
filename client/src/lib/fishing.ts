// Server-owned fishing economy and public catalogue (docs/fishing.md).
export interface Species { id: string; name: string; rarity: number; average_cm: number; base_value: number; colour: string; shape: string; motif: number; description: string }
export interface Specimen { id: string; species: string; length_cm: number; grade: number; value: number; caught_by: string; at: number }
export interface Angler { user_id: string; bite_at: number; expires_at: number }
export interface Pond { seats: Angler[]; now: number }
export interface Collection { records: Record<string, Specimen>; cards: Record<string, number>; badges: number[] }
export interface FishingAccount extends Collection { version: number; coins: number; fish: Specimen[] | null; packs: number; tools: Record<string, number>; equipped: string[] | null; auto_at: number; steal_at: number; ward_at: number; room: string; last: string; opened: string[] | null }
export interface FishingRules { version: number; catalog: Species[]; wait_min_seconds: number; wait_max_seconds: number; bite_seconds: number; start_coins: number; pack_price: number; inventory_limit: number; pack_limit: number; fish_weights: number[]; size_weights: number[]; size_deviation: number[]; size_value: number[]; card_weights: number[]; loot_weights: number[]; money_min: number; money_max: number; tool_prices: number[]; speed_percent: number[]; auto_cd_seconds: number[]; value_percent: number[]; steal_cd_seconds: number[]; steal_percent: number[]; ward_cd_seconds: number[] }
export interface FishingAction { action: 'sell' | 'buy_tool' | 'equip' | 'unequip' | 'buy_pack' | 'open_pack'; item?: string; quality?: number; fishIds?: string[] }
export const FISH_RARITY = ['常见', '奇异', '稀有', '史诗', '传说'];
export const CARD_RARITY = ['铁', '铜', '银', '金', '镭射'];
export const QUALITY = ['朴素', '精良', '稀有', '史诗', '传说'];
export const SIZE_GRADE = ['寻常', '出众', '罕见', '极端', '奇迹'];
export const TOOLS = { speed: '疾风钓竿', auto: '机械钓竿', value: '点金钓竿', glove: '幻影手套', ward: '守鱼结界' };
export type Tool = keyof typeof TOOLS;
export const TOOL_KEYS = Object.keys(TOOLS) as Tool[];
export function toolEffect(r: FishingRules, k: Tool, q: number) { const i = q - 1; return k === 'speed' ? `等待缩短 ${r.speed_percent[i]}%` : k === 'auto' ? `自动收杆一次，冷却 ${r.auto_cd_seconds[i]} 秒` : k === 'value' ? `鱼的价值增加 ${r.value_percent[i]}%` : k === 'glove' ? `偷鱼成功率 ${r.steal_percent[i]}%，冷却 ${r.steal_cd_seconds[i]} 秒` : `自动挡一次偷鱼，冷却 ${r.ward_cd_seconds[i]} 秒`; }
export function cardParts(key: string): [number, string] { const [tier, id] = key.split(':'); return [Number(tier), id]; }
export function collectionProgress(c: Collection): number[] { return CARD_RARITY.map((_, tier) => Object.entries(c.cards).filter(([key, n]) => key.startsWith(`${tier}:`) && n > 0).length); }
export function recordsOf(c: Collection): Specimen[] { return [...new Map(Object.values(c.records).map((f) => [f.id, f])).values()]; }
export function exhibitCapacity(kind: string, w: number, h: number) { return kind === 'fishing_fish' ? Math.floor(w * h / 2) : w * h; }
export function isBiting(p: Angler, now: number) { return p.user_id !== '0' && now >= p.bite_at && now <= p.expires_at; }

export const FISHING_ACCOUNT_EVENT = 'am-fishing-account';
