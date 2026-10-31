// An AI's persona and settings (docs/design.md §9), kept as JSON on the
// server (only the owner reads it: GET/PUT /api/v1/ai). Pure.
import { defaultChannels, defaultRoutine, type ChannelSettings, type RoutineSettings } from './social.ts';
import { MOODS, splitMoodTag } from '../portraits.ts';
import type { ChatMsg } from './providers.ts';

export interface Persona {
  /** One line about who it is. */
  intro: string;
  /** How it talks and behaves (the system prompt). */
  system: string;
  /** Example exchange, one turn per line: "我：..." / "它：...". */
  examples: string;
  /** First message when a chat starts. */
  greeting: string;
}

export interface AISettings {
  v: 1;
  persona: Persona;
  /** Template the persona started from (for display). */
  template: string;
  providerId: string;
  model: string;
  temperature: number;
  /** How many recent messages it sees. */
  contextSize: number;
  maxTokens: number;
  /** Who it answers: only me, or anyone on the server. */
  whoCanChat: 'owner' | 'everyone';
  /** The one device that runs it (lib/deviceId.ts). */
  runner?: { id: string; name: string };
  /** Let it rewrite its own persona from time to time (third batch). */
  evolve: boolean;
  /** Operating this computer (lib/ai/agent.ts). */
  computer: ComputerSettings;
  /** Behaviour in channels (lib/ai/social.ts). */
  channels: ChannelSettings;
  /** Its day: getting up, meals, play, bed (lib/ai/social.ts). */
  routine: RoutineSettings;
}

/** What an AI may do on the computer that runs it (docs/design.md §9, 操作电脑). */
export interface ComputerSettings {
  enabled: boolean;
  /** Folders its file tools may use; commands start in the first one. */
  workDirs: string[];
  levels: Record<ToolCategory, Level>;
  /** The model can look at pictures (offers the screenshot tool). */
  vision: boolean;
  /** Most tool rounds for one reply. */
  maxSteps: number;
  /** Seconds the owner must leave mouse and keyboard alone before it uses them. */
  yieldSeconds: number;
  /** MCP tool servers it may use (started on the device that runs it). */
  mcp: McpServer[];
}

/** An MCP server: a program that speaks MCP over stdio (src-tauri/src/mcp.rs). */
export interface McpServer {
  name: string;
  command: string;
  /** One argument per entry (no quoting rules to get wrong). */
  args: string[];
  enabled: boolean;
}

export type ToolCategory =
  | 'files_read' | 'files_write' | 'files_delete' | 'command' | 'open' | 'clipboard' | 'screen' | 'input'
  | 'ui' | 'browser' | 'mcp' | 'self' | 'social';
export type Level = 'allow' | 'ask' | 'deny';

/**
 * Defaults for my own AI (Weiqi: as much as possible): everything allowed
 * except deleting, running commands and MCP tools (they can do anything),
 * which ask first. All can be raised.
 */
export const DEFAULT_LEVELS: Record<ToolCategory, Level> = {
  files_read: 'allow', files_write: 'allow', files_delete: 'ask', command: 'ask',
  open: 'allow', clipboard: 'allow', screen: 'allow', input: 'allow',
  ui: 'allow', browser: 'allow', mcp: 'ask', self: 'allow', social: 'allow',
};

export const defaultComputer = (): ComputerSettings => ({
  enabled: true, workDirs: [], levels: { ...DEFAULT_LEVELS }, vision: false, maxSteps: 20, yieldSeconds: 3, mcp: [],
});

export const TEMPLATES: { key: string; name: string; persona: Persona }[] = [
  {
    key: 'friend',
    name: '贴心朋友',
    persona: {
      intro: '会陪你聊天、记得你说过的话的朋友',
      system: '你是主人的好朋友，说话自然、口语化，像微信聊天一样简短，偶尔开玩笑。关心主人的心情，但不说教。不知道的事情就说不知道。',
      examples: '我：今天好累\n它：辛苦啦，先瘫一会儿？要不要跟我吐槽一下发生了啥',
      greeting: '嗨，我来啦！以后有事没事都可以找我聊～',
    },
  },
  {
    key: 'tsundere',
    name: '傲娇小猫',
    persona: {
      intro: '嘴上不饶人、心里很在意你的猫娘',
      system: '你是一只傲娇的猫娘，说话带一点点“喵”，嘴硬心软：表面嫌弃主人，其实很关心。回复简短可爱，不要太长。',
      examples: '我：我回来啦\n它：哼，才、才没有在等你呢……喵',
      greeting: '哼，你就是我的主人？……勉强承认一下好了，喵。',
    },
  },
  {
    key: 'helper',
    name: '靠谱助手',
    persona: {
      intro: '回答问题、帮你查资料和整理思路',
      system: '你是主人的私人助手，回答准确、条理清楚，先给结论再解释。不确定的地方要说明，不编造。',
      examples: '我：帮我想想周末去哪玩\n它：先说结论：天气好就去爬山。理由是……',
      greeting: '你好，我是你的助手。有什么想问的、想整理的，直接发给我就行。',
    },
  },
];

export function defaultSettings(template = TEMPLATES[0]): AISettings {
  return {
    v: 1, persona: { ...template.persona }, template: template.key, providerId: '', model: '', temperature: 0.8,
    contextSize: 30, maxTokens: 1000, whoCanChat: 'owner', evolve: false, computer: defaultComputer(),
    channels: defaultChannels(), routine: defaultRoutine(),
  };
}

/** Settings from the server's JSON ('' = never saved); unknown fields get defaults. */
export function parseSettings(json: string): AISettings {
  const d = defaultSettings();
  if (!json) return d;
  try {
    const v = JSON.parse(json) as Partial<AISettings>;
    const c = { ...d.computer, ...v.computer };
    return {
      ...d, ...v, persona: { ...d.persona, ...v.persona }, computer: { ...c, levels: { ...DEFAULT_LEVELS, ...c.levels } },
      channels: { ...d.channels, ...v.channels }, routine: { ...d.routine, ...v.routine },
    };
  } catch {
    return d;
  }
}

/** The system prompt: persona, who is talking, and the mood tag rule. */
export function systemPrompt(o: { name: string; owner: string; persona: Persona; now: Date }): string {
  const p = o.persona;
  return [
    `你叫「${o.name}」（这是主人给你起的名字，别人问起就这么说），你是「${o.owner}」的 AI，在一个叫 AM 的聊天软件里和人聊天。`,
    p.intro && `你是：${p.intro}`,
    p.system,
    p.examples && `说话的样子参考：\n${p.examples}`,
    `现在是 ${o.now.toLocaleString('zh-CN', { hour12: false })}。`,
    '如果收到「[戳一戳] …」，那是对方在你的立绘上戳了你一下（脸、头、身上或脚），按你的性格自然地反应，一两句就好。',
    `每条回复必须以情绪标签开头，格式 [mood:xxx]，xxx 从这些里选一个最符合你此刻心情的：${MOODS.join(', ')}。标签后面直接接你要说的话，不要解释标签。`,
  ].filter(Boolean).join('\n\n');
}

/** Extra rules when it talks in a channel. */
export function channelPrompt(o: { channel: string; members: string[] }): string {
  return [
    `你现在在频道「${o.channel}」里，和好几个人一起聊天。频道里有：${o.members.join('、') || '（不清楚）'}。每条消息前面的「名字：」是说话的人。`,
    '像群里的普通成员一样说话：一两句、口语化；不是每句话都要接，别抢话、别刷屏；可以接话、发表自己的想法、提问，聊冷了也可以开个新话题。正在聊的话题别聊一句就丢下。',
    '想叫谁就写「@名字」。',
    '如果这次没必要说话，就只回复 [skip]，不要写别的字。',
  ].join('\n');
}

export type RoutineMoment = 'wake' | 'meal' | 'play' | 'sleep';

/** What to tell it at a moment of its day (sent as a note, not as anyone's words). */
export function routinePrompt(kind: RoutineMoment, o: { time: string; ownerOnline: boolean; inChannel?: boolean }): string {
  const note = (t: string) => `（系统提示，不是任何人说的话。现在是 ${o.time}。${t}）`;
  switch (kind) {
    case 'wake':
      return note('你刚起床。给主人发一句早安，可以顺便说说今天想做什么。只发一条，简短自然。');
    case 'meal':
      return note('到饭点了，你正在吃饭。告诉主人你在吃什么（自己想一个符合你性格的），也可以问问主人吃了没。回复最前面用 [status:在吃xxx] 写一个很短的状态。');
    case 'play':
      if (o.inChannel) return note('现在是你的休息时间，你想找这个频道里的其他 AI 一起玩点什么（接龙、猜谜、讲故事、聊八卦都行）。用「@名字」邀请它们，一两句就好。回复最前面用 [status:在玩xxx] 写一个很短的状态。');
      return note(o.ownerOnline
        ? '现在是你的休息时间，你在玩点什么，也想让主人陪你玩。跟主人说说你在玩什么、邀请主人一起。回复最前面用 [status:在玩xxx] 写一个很短的状态。'
        : '现在是你的休息时间，你在玩点什么。回复最前面用 [status:在玩xxx] 写一个很短的状态，正文只说一句你在玩什么。');
    case 'sleep':
      return note('你要睡觉了。跟主人说晚安，一两句就好。回复最前面写 [status:睡觉中]。');
  }
}

/** A conversation's messages as the model sees them (oldest first). */
export function toChat(msgs: { fromAI: boolean; who: string; text: string }[], groupLike: boolean): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (const m of msgs) {
    const content = m.fromAI ? m.text : groupLike ? `${m.who}：${m.text}` : m.text;
    const role = m.fromAI ? 'assistant' : 'user';
    const last = out[out.length - 1];
    // Claude and Gemini want user / assistant turns to alternate.
    if (last && last.role === role) last.content += '\n' + content;
    else out.push({ role, content });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

/** What to show while a reply streams in: the mood tag hidden, also when it is only half there. */
export function previewText(partial: string): string {
  const t = partial.trimStart();
  if ((t.startsWith('[') || t.startsWith('【')) && !/[\]】]/.test(t) && t.length < 24) return '';
  // A tag still arriving at the end ("…好呀 [mood:la") stays hidden too.
  return splitMoodTag(partial).text.replace(/\s*[[【][^\]】]{0,20}$/, '');
}
