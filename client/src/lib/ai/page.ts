// An AI arranging its own profile page (docs/design.md §9 自己的主页):
// what it reads about the page, and its edits (add / change / move /
// remove a widget, the background). Pure and tested; the runner saves the
// result through Session.saveProfile, and the server checks it as usual.
import { kindInfo } from '../widgetKinds.ts';
import { GRID, firstFree, fits, placements, type Background, type Cell, type LayoutModel, type WidgetModel } from '../widgets.ts';

/** Kinds it can fill in by itself (no uploads needed; songs come from NetEase links). */
export const AI_KINDS = ['text', 'links', 'countdown', 'stats', 'guestbook', 'status', 'song', 'playlist'] as const;

const HOW: Record<(typeof AI_KINDS)[number], string> = {
  text: 'text 文字卡片：{"title":"标题(40字内)","text":"正文(1000字内)"}，最小 2×1',
  links: 'links 链接：{"items":[{"title":"名字","url":"https://…"}]}（最多 6 个），最小 2×1',
  countdown: 'countdown 倒计时：{"title":"标题","date":"2026-12-25"}，最小 1×1',
  stats: 'stats 统计：{"items":["messages","streak","joined"]}（发过的消息、连续在线、加入时间），最小 2×1',
  guestbook: 'guestbook 留言板：{"title":"留言板"}，最小 2×2',
  status: 'status 我的状态：{}，最小 2×1',
  song: 'song 一首歌：{"netease_link":"网易云歌曲分享链接","blur":false}，最小 2×1',
  playlist: 'playlist 歌单：{"netease_link":"网易云歌单分享链接"}，最小 2×2',
};

const short = (v: unknown, n = 40) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** The page as text for the model: board size, each widget, the background, what it may add. */
export function describePage(l: LayoutModel): string {
  const g = GRID.landscape;
  const lines = [`主页是 ${g.cols} 列 × ${g.rows} 行的格子，最多 3 页（page 0–2），每个小组件最大 4×4，不能重叠。`];
  if (!l.widgets.length) lines.push('现在是空的。');
  for (const w of l.widgets) {
    const c = w.config;
    const what = c.title || c.text ? `「${short(c.title ?? '')}」${c.text ? short(c.text) : ''}` : '';
    lines.push(`- [${w.id}] ${kindInfo(w.kind)?.label ?? w.kind}（${w.kind}）${w.w}×${w.h}，第 ${w.land.page} 页 x=${w.land.x} y=${w.land.y} ${what}`);
  }
  const bg = l.background;
  lines.push(`背景：${bg.kind ? `${bg.kind} ${bg.value}` : '默认'}（可以换成 color #rrggbb，或 gradient：sakura、ocean、mint、sunset、night、forest）。`);
  lines.push('能放的小组件和 config 写法：\n' + AI_KINDS.map((k) => '  ' + HOW[k]).join('\n'));
  return lines.join('\n');
}

export interface PageEdit {
  action: 'add' | 'update' | 'move' | 'remove' | 'background';
  id?: string;
  kind?: string;
  w?: number;
  h?: number;
  page?: number;
  x?: number;
  y?: number;
  config?: Record<string, unknown>;
  background?: { kind: 'color' | 'gradient' | ''; value: string };
}

/** "2026-12-25" / ms -> ms (countdown dates). */
function dateMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v.length === 10 ? `${v}T00:00:00` : v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function cleanConfig(kind: string, base: Record<string, unknown>, c: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base, ...c };
  delete out.netease_link;
  if (kind === 'countdown') out.date = dateMs(out.date);
  return out;
}

/** Applies one edit; returns the new layout, or a reason (Chinese, for the model). */
export function editPage(l: LayoutModel, e: PageEdit, newId: () => string): LayoutModel | string {
  const o = 'landscape';
  const pl = placements(l, o);
  const find = () => l.widgets.find((w) => w.id === e.id);
  const clampSize = (n: number | undefined, min: number, def: number) => Math.max(min, Math.min(4, Math.round(n ?? def)));
  const at = (w: number, h: number, skip?: string): Cell | null => {
    if (e.x !== undefined && e.y !== undefined) {
      const cell = { page: Math.max(0, Math.min(2, Math.round(e.page ?? 0))), x: Math.round(e.x), y: Math.round(e.y) };
      return fits(l.widgets, pl, o, cell, w, h, skip) ? cell : null;
    }
    return firstFree(l.widgets.filter((x) => x.id !== skip), pl, o, w, h, Math.max(0, Math.min(2, Math.round(e.page ?? 0))));
  };
  switch (e.action) {
    case 'add': {
      const kind = e.kind ?? '';
      const info = kindInfo(kind);
      if (!info || !(AI_KINDS as readonly string[]).includes(kind)) return `不能放「${kind}」，能放：${AI_KINDS.join('、')}`;
      const w = clampSize(e.w, info.minW, info.w);
      const h = clampSize(e.h, info.minH, info.h);
      const cell = at(w, h);
      if (!cell) return e.x !== undefined ? '那个位置放不下（出界或和别的重叠），换个位置或者不写 x / y 让它自己找空位' : '主页放满了，先删掉一些';
      const widget: WidgetModel = { id: newId(), kind, source: 'builtin', w, h, land: cell, config: cleanConfig(kind, info.config(), e.config ?? {}), contentEditors: 'everyone' };
      return { ...l, portraitCustom: false, widgets: [...l.widgets, widget] };
    }
    case 'update': {
      const cur = find();
      if (!cur) return `没有编号 ${e.id} 的小组件`;
      return { ...l, widgets: l.widgets.map((w) => (w.id === cur.id ? { ...w, config: cleanConfig(w.kind, w.config, e.config ?? {}) } : w)) };
    }
    case 'move': {
      const cur = find();
      if (!cur) return `没有编号 ${e.id} 的小组件`;
      const info = kindInfo(cur.kind);
      const w = clampSize(e.w, info?.minW ?? 1, cur.w);
      const h = clampSize(e.h, info?.minH ?? 1, cur.h);
      const cell = e.x === undefined && e.page === undefined && w === cur.w && h === cur.h ? cur.land : at(w, h, cur.id);
      if (!cell) return '那个位置或大小放不下（出界或和别的重叠）';
      return { ...l, portraitCustom: false, widgets: l.widgets.map((x) => (x.id === cur.id ? { ...x, w, h, land: cell } : x)) };
    }
    case 'remove': {
      if (!find()) return `没有编号 ${e.id} 的小组件`;
      return { ...l, portraitCustom: false, widgets: l.widgets.filter((w) => w.id !== e.id) };
    }
    case 'background': {
      const b = e.background;
      if (!b) return '要写 background';
      const ok = b.kind === '' || (b.kind === 'color' && /^#[0-9a-f]{6}$/i.test(b.value)) || (b.kind === 'gradient' && ['sakura', 'ocean', 'mint', 'sunset', 'night', 'forest'].includes(b.value));
      if (!ok) return '背景只能是 color #rrggbb，或 gradient sakura / ocean / mint / sunset / night / forest，或空（默认）';
      const background: Background = { ...l.background, kind: b.kind, value: b.kind ? b.value : '', mediaId: undefined };
      return { ...l, background };
    }
  }
  return '不认识的 action';
}
