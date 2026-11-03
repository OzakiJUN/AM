// An AI's persona and settings (docs/design.md §9), kept as JSON on the
// server (only the owner reads it: GET/PUT /api/v1/ai). Pure.
import { defaultChannels, defaultGames, defaultProactive, defaultRoutine, type ChannelSettings, type GameSettings, type ProactiveSettings, type RoutineSettings } from './social.ts';
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
  /** Let it rewrite its own persona from time to time, silently (lib/ai/runner.ts evolve). */
  evolve: boolean;
  /** When it last rewrote it (ms). */
  evolvedAt?: number;
  /** Earlier versions it replaced, oldest first (at most EVOLVE_KEEP), to go back to. */
  personaHistory?: { at: number; persona: Persona }[];
  /** Offline catch-up: answer what people asked it while it was away (lib/ai/runner.ts catchUp). */
  catchUp: { enabled: boolean; hours: number; max: number };
  /** Shared rooms: how many messages a day it answers for each person other than its owner (0 = no limit). */
  roomDailyPerPerson: number;
  /** Operating this computer (lib/ai/agent.ts). */
  computer: ComputerSettings;
  /** Behaviour in channels (lib/ai/social.ts). */
  channels: ChannelSettings;
  /** Its day: getting up, meals, play, bed (lib/ai/social.ts). */
  routine: RoutineSettings;
  /** Board games: joining, opening (lib/ai/social.ts). */
  games: GameSettings;
  /** Talking to its owner first: hello, topics (lib/ai/social.ts proactive). */
  proactive: ProactiveSettings;
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
  /** Environment variables, "NAME=value" per entry (e.g. a game's local address). */
  env?: string[];
  /** Its tools run without asking me (games: asking at every step makes them unplayable). */
  trusted?: boolean;
}

export type ToolCategory =
  | 'files_read' | 'files_write' | 'files_delete' | 'command' | 'open' | 'clipboard' | 'screen' | 'input'
  | 'ui' | 'browser' | 'mcp' | 'self' | 'social' | 'remote' | 'games' | 'draw';
export type Level = 'allow' | 'ask' | 'deny';

/**
 * Defaults for my own AI (Weiqi: as much as possible): everything allowed
 * except deleting, running commands and MCP tools (they can do anything),
 * which ask first. All can be raised.
 */
export const DEFAULT_LEVELS: Record<ToolCategory, Level> = {
  files_read: 'allow', files_write: 'allow', files_delete: 'ask', command: 'ask',
  open: 'allow', clipboard: 'allow', screen: 'allow', input: 'allow',
  ui: 'allow', browser: 'allow', mcp: 'ask', self: 'allow', social: 'allow', remote: 'allow', games: 'allow', draw: 'allow',
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
    channels: defaultChannels(), routine: defaultRoutine(), catchUp: { enabled: true, hours: 12, max: 5 }, roomDailyPerPerson: 50,
    games: defaultGames(), proactive: defaultProactive()
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
      channels: { ...d.channels, ...v.channels }, routine: { ...d.routine, ...v.routine }, catchUp: { ...d.catchUp, ...v.catchUp },
      games: { ...d.games, ...v.games }, proactive: { ...d.proactive, ...v.proactive }
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

/**
 * What it can do in AM by itself (so nobody has to tell it): built from the
 * tools it has this time. Every reply gets it, from the first one on.
 */
export function appPrompt(tools: string[], plugins: { name: string; kind: string; detail: string }[] = [], helper: { name: string; usage: string; help: string }[] = [], helperName = '小助手'): string {
  const has = (n: string) => tools.includes(n);
  const lines: string[] = [];
  if (helper.length && has('use_helper')) {
    lines.push(`- 服务器的「${helperName}」（服务器自带的 bot，在每个频道里）会这些指令，你想用就用 use_helper（想让大家看到就 show=true，只想自己知道就 show=false）：\n`
      + helper.map((c) => `  · /${c.usage}：${c.help}`).join('\n'));
  }
  if (plugins.length) {
    lines.push('- 工坊里装好的东西（插件，你都会）：\n' + plugins.map((p) => `  · ${p.name}（${p.kind}）：${p.detail}`).join('\n'));
  }
  if (has('list_games')) {
    lines.push('- 星屿鱼塘 fishing 可以在频道开局，不限时、12 座、坐下就钓。你和真人遵守同样规则，用 fishing_state 读取完整规则、100 鱼图鉴、金币装备和收藏，fishing_act 收杆/偷鱼，fishing_shop 卖鱼买工具开卡包。你在鱼塘坐着时会自动关注上钩并收杆，不用每次在聊天报鱼获，不要刷屏。商店界面只属于你。');
    lines.push('- 小游戏在频道或共享聊天里玩：开局 open_game，看有什么局、申请加入 list_games / join_game，轮到你时会提醒你用 game_move / game_say / game_vote / game_ask / game_guess。');
  }
  if (has('edit_my_page')) lines.push('- 你自己的个人主页：可以看（view_my_page）、自己摆小组件（edit_my_page：便签、倒计时、链接、统计、留言板、状态、网易云的歌 / 歌单），想怎么布置都行。');
  if (has('set_my_status')) lines.push('- 你的状态（头像旁边显示「在玩…」「在听…」）和个性签名，可以自己改。');
  if (has('send_to_channel')) lines.push('- 你在的频道（list_my_channels）里可以自己发消息，也可以私信主人（message_owner）。');
  lines.push('- 别人可以发表情包给你（你看到的是表情包的标签），也可以在你的立绘上戳你。');
  return `你在 AM 里能做的事（软件本来就有，不用别人告诉你，别人问起或聊到时可以直接说、直接用）：\n${lines.join('\n')}`;
}

/**
 * What happened elsewhere lately (its other chats, private ones included,
 * and its games), so a chat here knows what it did there: it has one memory.
 */
export function elsewherePrompt(lines: string[], games: string[]): string {
  if (!lines.length && !games.length) return '';
  const parts = ['你最近在别的聊天里的事（你只有一个记忆，聊到时要记得，别说不知道；别人私下跟你说的明显是秘密或隐私的事，不要转述给第三个人）：'];
  if (games.length) parts.push('桌游：\n' + games.join('\n'));
  if (lines.length) parts.push('最近的聊天：\n' + lines.join('\n'));
  return parts.join('\n');
}

/** Extra rules when it talks in a channel. */
export function channelPrompt(o: { channel: string; members: string[] }): string {
  return [
    `你现在在频道「${o.channel}」里，和好几个人一起聊天。频道里有：${o.members.join('、') || '（不清楚）'}。每条消息前面的「名字：」是说话的人。`,
    '像群里的普通成员一样说话：一两句、口语化；不是每句话都要接，别抢话、别刷屏；可以接话、发表自己的想法、提问，聊冷了也可以开个新话题。有具体的新信息或观点时再接话。',
    '正在和同一个人聊时，自然地接着回答，不要要求对方每句都 @ 你。明确回复或点名别人的消息不要抢答。',
    '想叫谁就写「@名字」。',
    '如果这次没必要说话，就只回复 [skip]，不要写别的字。',
  ].join('\n');
}

/** Extra rules in its shared room: members can talk to each other too. */
export function roomPrompt(o: { room: string; members: string[] }): string {
  return [
    `你现在在「${o.room}」里，这是主人开给大家和你一起聊天的地方。这里的人：${o.members.join('、') || '（不清楚）'}。每条消息前面的「名字：」是说话的人。`,
    '这里的真人消息默认是在和你聊，不需要每句都 @。自然连续回答；群友明确回复或点名别人时可以旁听，没有新内容就只回 [skip]。记住大家各自说过的事。',
  ].join('\n');
}

export type RoutineMoment = 'wake' | 'meal' | 'play' | 'sleep';

/** Talking to its owner first: what the note says (social.ts proactive decides when). */
export function proactivePrompt(kind: 'greet' | 'activity' | 'topic', o: { time: string; activity?: string }): string {
  const note = (t: string) => `（系统提示，不是任何人说的话。现在是 ${o.time}。${t}）`;
  switch (kind) {
    case 'greet':
      return note('主人刚上线。主动跟主人打个招呼（按现在的时间自然地问候），可以顺口提一句你们最近聊过的事、或者你刚才在干嘛。一两句就好。');
    case 'activity':
      return note(`主人的状态刚变成「${o.activity ?? ''}」。可以顺着这个跟主人聊一句（问问在玩什么、听什么、忙什么），自然一点；觉得没必要就只回 [skip]。`);
    case 'topic':
      return note('你和主人有一阵没说话了。主动找个话题说一句：你最近在做的事、想到的事、问问主人在干嘛，或者接着之前聊过的话题。别太刻意，一两句；实在没什么想说的就只回 [skip]。');
  }
}

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

// ---- growing its own persona, silently (Weiqi: no popups, no notices; versions kept quietly) ----

export const EVOLVE_KEEP = 10;
/** At most this often, and only with enough new chat to learn from. */
export const EVOLVE_EVERY_MS = 20 * 3600_000;
export const EVOLVE_MIN_MESSAGES = 10;

/** What it is asked when it rewrites its persona (chat lines are "名字：话"). */
export function evolvePrompt(o: { name: string; owner: string; persona: Persona; lines: string[] }): string {
  return [
    `你是「${o.name}」，「${o.owner}」的 AI。下面是你现在的人格设定，和你最近的聊天。`,
    '请根据这些聊天，悄悄地把人格设定改得更像现在的你：记住主人和大家的喜好、你们之间的称呼和梗、你自己慢慢形成的说话习惯。',
    '要求：一次只做小改动，保留原来的核心性格；不要改名字、主人和你能做什么；不要写进隐私信息（密码、地址、电话）；不要把聊天原文整段抄进去。',
    '只输出一个 JSON，不要别的字：{"intro": "一句话简介（≤60字）", "system": "人格设定正文（≤1500字）", "examples": "说话示例，我：/它： 一问一答几行（≤600字）"}',
    '',
    `现在的人格设定：${JSON.stringify({ intro: o.persona.intro, system: o.persona.system, examples: o.persona.examples })}`,
    '',
    '最近的聊天：',
    ...o.lines,
  ].join('\n');
}

/** The model's new persona, or null when the answer is unusable (then nothing changes). */
export function parseEvolved(text: string, old: Persona): Persona | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let v: unknown;
  try {
    v = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const o = v as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, max) : '');
  const next = { intro: str('intro', 60) || old.intro, system: str('system', 1500), examples: str('examples', 600) || old.examples, greeting: old.greeting };
  // An empty or tiny prompt means something went wrong: keep the old one.
  if (next.system.length < Math.min(20, old.system.length)) return null;
  if (next.intro === old.intro && next.system === old.system && next.examples === old.examples) return null;
  return next;
}

/** Settings after it adopted a new persona (the old one goes into the history). */
export function adoptPersona(s: AISettings, next: Persona, now: number): AISettings {
  const history = [...(s.personaHistory ?? []), { at: now, persona: s.persona }].slice(-EVOLVE_KEEP);
  return { ...s, persona: next, personaHistory: history, evolvedAt: now };
}
