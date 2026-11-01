// What is installed from the creative workshop (docs/design.md §13). For
// now only the items that ship with the client; downloads from GitHub will
// be added to `useWorkshop`. AIs learn every installed item ("plugins",
// lib/ai/memory.ts newPlugins): once when they first run, and again
// whenever something new is installed.
import { create } from 'zustand';
import { TEMPLATES } from './ai/persona';
import { GAME_INFO, KINDS, type GameKind } from './games';
import { MOODS } from './portraits';

export type WorkshopCategory = 'game' | 'portrait' | 'persona' | 'theme' | 'widget';

export interface WorkshopItem {
  id: string;
  category: WorkshopCategory;
  name: string;
  /** One line for cards. */
  text: string;
  /** How to use it (detail dialog, and what AIs read). */
  detail: string;
  game?: GameKind;
  builtin: boolean;
}

export const CATEGORY_NAME: Record<WorkshopCategory, string> = {
  game: '小游戏', portrait: 'AI 形象包', persona: '人格', theme: '主题', widget: '主页组件',
};

const GAME_TEXT: Record<GameKind, string> = {
  gomoku: '两个人轮流下，先连五个的赢。AI 也会下（不算很强）。',
  reversi: '夹住就翻，最后子多的赢。和 AI 下正合适。',
  undercover: '4–8 个人（AI 也算）各拿一个词，轮流描述、投票找卧底。',
};

/** Everything that ships with the client (always installed, can't be removed). */
export const BUILT_IN: WorkshopItem[] = [
  ...KINDS.map((k): WorkshopItem => ({ id: `game:${k}`, category: 'game', name: GAME_INFO[k].name, text: GAME_TEXT[k], detail: GAME_INFO[k].rules, game: k, builtin: true })),
  {
    id: 'portrait:default', category: 'portrait', name: '默认立绘', builtin: true,
    text: `没有自己形象包的 AI 都用这套（${MOODS.length} 种情绪）`,
    detail: '给自己的 AI 换立绘：AI 设置 →「资料」→「立绘（形象包）」，按情绪命名的一组图片一次导入。',
  },
  ...TEMPLATES.map((t): WorkshopItem => ({
    id: `persona:${t.key}`, category: 'persona', name: t.name, text: t.persona.intro, builtin: true,
    detail: '新建 AI 时选它当起始人格，或者在 AI 设置 →「人格」里一键换成它。',
  })),
];

/** Installed items (built-ins + downloads later); AIs watch this to learn new ones. */
export const useWorkshop = create<{ installed: WorkshopItem[] }>(() => ({ installed: BUILT_IN }));
