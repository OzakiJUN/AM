// An AI's persona and settings (docs/design.md §9), kept as JSON on the
// server (only the owner reads it: GET/PUT /api/v1/ai). Pure.
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
}

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
    contextSize: 30, maxTokens: 1000, whoCanChat: 'owner', evolve: false,
  };
}

/** Settings from the server's JSON ('' = never saved); unknown fields get defaults. */
export function parseSettings(json: string): AISettings {
  const d = defaultSettings();
  if (!json) return d;
  try {
    const v = JSON.parse(json) as Partial<AISettings>;
    return { ...d, ...v, persona: { ...d.persona, ...v.persona } };
  } catch {
    return d;
  }
}

/** The system prompt: persona, who is talking, and the mood tag rule. */
export function systemPrompt(o: { name: string; owner: string; persona: Persona; now: Date }): string {
  const p = o.persona;
  return [
    `你的名字是「${o.name}」，你是「${o.owner}」的 AI，在一个叫 AM 的聊天软件里和人聊天。`,
    p.intro && `你是：${p.intro}`,
    p.system,
    p.examples && `说话的样子参考：\n${p.examples}`,
    `现在是 ${o.now.toLocaleString('zh-CN', { hour12: false })}。`,
    `每条回复必须以情绪标签开头，格式 [mood:xxx]，xxx 从这些里选一个最符合你此刻心情的：${MOODS.join(', ')}。标签后面直接接你要说的话，不要解释标签。`,
  ].filter(Boolean).join('\n\n');
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
  if (t.startsWith('[') && !t.includes(']') && t.length < 24) return '';
  return splitMoodTag(partial).text;
}
