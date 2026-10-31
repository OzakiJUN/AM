// Built-in widget kinds (server checks the same list: server/internal/profile).
// Sizes are in cells; every widget may grow up to 4 x 4.

export type ProfileKind = 'user' | 'server';

export interface KindInfo {
  kind: string;
  label: string;
  emoji: string;
  desc: string;
  minW: number;
  minH: number;
  /** Size when added. */
  w: number;
  h: number;
  only?: ProfileKind;
  config: () => Record<string, unknown>;
}

export const KINDS: KindInfo[] = [
  { kind: 'text', label: '文字卡片', emoji: '📝', desc: '标题和一段文字，当公告、自我介绍都行', minW: 2, minH: 1, w: 2, h: 2, config: () => ({ title: '', text: '' }) },
  { kind: 'image', label: '图片', emoji: '🖼️', desc: '一张图，可以加说明', minW: 1, minH: 1, w: 2, h: 2, config: () => ({ media_id: '', caption: '', fit: 'cover' }) },
  { kind: 'gallery', label: '照片墙', emoji: '🎞️', desc: '选好几张照片自动轮播', minW: 2, minH: 2, w: 2, h: 2, config: () => ({ media_ids: [], interval: 5, caption: '' }) },
  { kind: 'links', label: '链接', emoji: '🔗', desc: '最多 6 个链接', minW: 2, minH: 1, w: 2, h: 2, config: () => ({ items: [] }) },
  { kind: 'countdown', label: '倒计时', emoji: '⏳', desc: '离某一天还有几天', minW: 1, minH: 1, w: 2, h: 1, config: () => ({ title: '', date: 0 }) },
  { kind: 'stats', label: '统计', emoji: '📊', desc: '发过多少消息、连续在线几天…', minW: 2, minH: 1, w: 4, h: 1, config: () => ({ items: [] }) },
  { kind: 'guestbook', label: '留言板', emoji: '💌', desc: '大家可以在这里留言', minW: 2, minH: 2, w: 2, h: 2, config: () => ({ title: '留言板' }) },
  { kind: 'music', label: '网易云歌单', emoji: '🎵', desc: '贴一个网易云歌单链接，放一个播放器', minW: 2, minH: 2, w: 2, h: 2, config: () => ({ provider: 'netease', playlist_id: '', title: '' }) },
  { kind: 'status', label: '我的状态', emoji: '🟢', desc: '在线、正在听歌、正在打游戏…', minW: 2, minH: 1, w: 2, h: 1, only: 'user', config: () => ({}) },
  { kind: 'online', label: '在线成员', emoji: '👥', desc: '现在谁在线', minW: 2, minH: 2, w: 2, h: 2, only: 'server', config: () => ({}) },
];

export const kindInfo = (kind: string) => KINDS.find((k) => k.kind === kind);

/** Stats a widget can show, per profile kind (first ones are the default). */
export const STAT_ITEMS: Record<ProfileKind, { key: string; label: string }[]> = {
  user: [
    { key: 'messages', label: '发过的消息' },
    { key: 'streak', label: '连续在线' },
    { key: 'joined', label: '加入服务器' },
  ],
  server: [
    { key: 'members', label: '成员' },
    { key: 'messages', label: '消息总数' },
    { key: 'channels', label: '频道' },
    { key: 'age', label: '开服' },
  ],
};

/** Gradient presets for profile backgrounds (names are stored). */
export const GRADIENTS: Record<string, [string, string]> = {
  sakura: ['#ffd6e7', '#e9d8ff'],
  ocean: ['#c9f0ff', '#d6dcff'],
  mint: ['#d4f7e8', '#e3f4ff'],
  sunset: ['#ffe0c7', '#ffd1e3'],
  night: ['#2b2350', '#14253f'],
  forest: ['#1f3b34', '#203047'],
};

/** "https://music.163.com/#/playlist?id=123" (or just "123") -> "123". */
export function neteasePlaylistId(input: string): string {
  const s = input.trim();
  if (/^\d{1,20}$/.test(s)) return s;
  const m = /[?&]id=(\d{1,20})/.exec(s) ?? /playlist\/(\d{1,20})/.exec(s);
  return m ? m[1] : '';
}

/** Whole days from today to `date` (ms); negative = in the past. */
export function daysUntil(date: number, now = Date.now()): number {
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  return day(date) - day(now);
}
