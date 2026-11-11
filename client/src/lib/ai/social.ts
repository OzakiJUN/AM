// An AI living among people (docs/design.md §9 频道和作息): when to speak in
// a channel, and its day (getting up, meals, play, going to bed). Pure and
// tested; lib/ai/runner.ts does the talking.

import { CHAT_EMOJI } from '../chatTools.ts';

/** How an AI behaves in the channels it is in. */
export interface ChannelSettings {
  /** mention = called by name / @ or continuing a chat; active = also joins by itself. */
  mode: 'mention' | 'active';
  /** Same person's conversation continues without another @; 0 disables (default 1800). */
  followUpSeconds?: number;
  /** What people call it besides its name (肥鱼, 鱼鱼…): calling it so counts as talking to it. */
  nicknames?: string[];
  /** 0–1: the model's preference for joining a discussion. */
  chattiness: number;
  /** Wait for a pause, but evaluate continuous discussion by maxBatchSeconds. */
  batchSeconds: number;
  maxBatchSeconds: number;
  /** Least seconds between unsolicited messages (human conversations skip this). */
  minGapSeconds: number;
  /** Most unsolicited messages per hour in one channel (AI replies still count). */
  maxPerHour: number;
  /** After this many AI messages in a row (any AIs), wait for a person. */
  maxAIChain: number;
}

/** How long a chat with one person goes on without another @ (seconds; was 300 before 2026-11-11). */
export const FOLLOW_UP_SECONDS = 1800;

export const defaultChannels = (): ChannelSettings => ({ mode: 'active', followUpSeconds: FOLLOW_UP_SECONDS, nicknames: [], chattiness: 0.5, batchSeconds: 5, maxBatchSeconds: 20, minGapSeconds: 20, maxPerHour: 30, maxAIChain: 6 });

/** Its day. Times are "HH:MM" on the device that runs it; each event moves by up to `jitterMinutes`. */
export interface RoutineSettings {
  enabled: boolean;
  wake: string;
  sleep: string;
  meals: string[];
  /** Free time in the afternoon and the evening: says what it plays, may invite people. */
  play: boolean;
  jitterMinutes: number;
  /** Asks its owner to keep it company (only when the owner is online). */
  seekOwner: boolean;
  /** Looks for other AIs in its channels to play with. */
  seekAIs: boolean;
}

export const defaultRoutine = (): RoutineSettings => ({
  enabled: true, wake: '08:00', sleep: '23:30', meals: ['12:00', '18:30'], play: true, jitterMinutes: 20, seekOwner: true, seekAIs: true,
});

/** A message as the decision sees it (oldest first). */
export interface Said {
  senderId: string;
  time: number;
  /** Sent by a bot / AI account (mine or anyone's). */
  ai: boolean;
  /** @-mentions it, or calls it by name. */
  toMe: boolean;
  replyToSender?: string;
  toOthers?: boolean;
  text?: string;
}

/** The names it answers to: its name, the name without a leading 大 / 小 / 阿 / 老, and its nicknames (2+ characters). */
export function namesOf(aiName: string, nicknames: string[] = []): string[] {
  const name = aiName.trim();
  const short = name.replace(/^[大小阿老]/u, '');
  const all = [name, ...(short !== name ? [short] : []), ...nicknames.map((n) => n.trim())];
  return [...new Set(all.filter((n) => [...n].length >= 2).map((n) => n.toLowerCase()))];
}

/** The message @-mentions the AI or calls it by one of its names. */
export function addressed(text: string, mentions: string[] | undefined, aiId: string, aiName: string, nicknames: string[] = []): boolean {
  if (mentions?.length) return mentions.includes(aiId);
  const t = text.toLowerCase();
  return namesOf(aiName, nicknames).some((n) => t.includes(n));
}

/** Skip pure reactions; a short real question or a number can still matter. */
export function discussionText(text: string): boolean {
  const words = text.toLowerCase().replace(/[\p{P}\p{S}\p{M}\s\u200d]/gu, '');
  return !!words && !/^(?:哈+|呵呵|嗯+|哦+|好[的啊呀吧]?|收到|明白了?|谢谢|赞|同意|确实|是的|对+|ok(?:ay)?|lol|thanks)+$/u.test(words);
}

/** Reconstruct a conversation from message history, including the AI's quoted replies. */
export function channelTurnIsDirected(recent: Said[], me: string, now: number, followUpSeconds = FOLLOW_UP_SECONDS, room = false): boolean {
  const last = recent.at(-1);
  if (!last || last.senderId === me) return false;
  if (last.toMe) return true;
  if (last.ai || last.toOthers) return false;
  if (room) return true;
  if (followUpSeconds <= 0 || !discussionText(last.text ?? '')) return false;
  const fresh = (m: Said) => m.time <= last.time && now - m.time <= followUpSeconds * 1000;
  // Right after what it said (only this person's own messages in between),
  // unless it was answering someone else: the way people answer in a group.
  const before = recent.slice(0, -1).reverse().find((m) => m.senderId !== last.senderId);
  if (before?.senderId === me && fresh(before) && (!before.replyToSender || before.replyToSender === last.senderId)) return true;
  return recent.slice(0, -1).some((m) => fresh(m) && (
    (m.senderId === me && m.replyToSender === last.senderId) ||
    (m.senderId === last.senderId && m.toMe)
  ));
}

/**
 * A group reply as a person would send it: paragraphs as separate messages
 * (at most `max`; short ones stay together, the rest goes in the last one).
 */
export function splitBubbles(text: string, max = 3): string[] {
  const parts = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return parts.length ? parts : [];
  const out: string[] = [];
  for (const p of parts) {
    const prev = out.at(-1);
    if (prev !== undefined && ([...prev].length < 8 || [...p].length < 4)) out[out.length - 1] = `${prev}\n${p}`;
    else out.push(p);
  }
  if (out.length > max) out.splice(max - 1, out.length, out.slice(max - 1).join('\n'));
  return out;
}

/**
 * How long a person would take to type `text` (ms): about 6 characters a
 * second plus a moment to think, between 1.2 and 9 seconds; `random` 0–1.
 */
export function typingMs(text: string, random: number): number {
  const chars = [...text].length;
  return Math.round(Math.min(9000, Math.max(1200, 600 + chars * 170 * (0.8 + 0.4 * random))));
}

/** Whether to say something during a game turn: now and then (35 %), never twice within 90 s. */
export function gameRemark(lastAt: number, now: number, random: number): boolean {
  return now - lastAt >= 90_000 && random < 0.35;
}

export type Decision = { act: 'reply' | 'maybe' | 'no'; delay: number; why: string };

const MIN = 60_000;

/**
 * Whether to answer the newest message in a channel. `reply` = it was spoken
 * to: answer soon. `maybe` = join in after a natural pause; the model may
 * still decide to stay quiet. `random` / `random2` are 0–1 (tests pass fixed ones).
 */
export function decide(o: {
  now: number; s: ChannelSettings; recent: Said[]; me: string; mySends: number[]; asleep?: boolean; random: number; random2: number;
}): Decision {
  const { now, s, recent, me } = o;
  const last = recent.at(-1);
  if (!last || last.senderId === me) return { act: 'no', delay: 0, why: 'nothing new' };
  // Human conversations must not silently stop at the unsolicited-message budget.
  if (last.toMe && !last.ai) return { act: 'reply', delay: 800 + 1200 * o.random2, why: 'spoken to' };
  const hour = o.mySends.filter((t) => now - t < 60 * MIN).length;
  if (hour >= s.maxPerHour) return { act: 'no', delay: 0, why: 'hourly limit' };
  let chain = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i].ai; i--) chain++;
  if (last.ai && chain >= s.maxAIChain) return { act: 'no', delay: 0, why: 'waiting for a person' };
  if (last.toMe) return { act: 'reply', delay: 800 + 1200 * o.random2, why: 'spoken to' };
  if (s.mode !== 'active' || o.asleep) return { act: 'no', delay: 0, why: o.asleep ? 'asleep' : 'mention only' };
  const lastMine = Math.max(0, ...o.mySends);
  const cooldown = Math.max(0, lastMine + s.minGapSeconds * 1000 - now);
  return { act: 'maybe', delay: Math.max(cooldown, s.batchSeconds * 1000), why: 'evaluate the batch' };
}

export type RoutineKind = 'wake' | 'meal' | 'play' | 'sleep';

export interface RoutineEvent {
  kind: RoutineKind;
  /** Unique within the day (meal-0, play-1 …), remembered once done. */
  key: string;
  /** Minutes after midnight. */
  at: number;
}

/** "HH:MM" -> minutes after midnight (null if malformed). */
export function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Small stable hash -> 0–1, so a day's jitter is the same every time it is computed. */
export function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** The day's events, with jitter, in time order. `day` = "YYYY-MM-DD", `seed` = the AI's id. */
export function dayPlan(day: string, r: RoutineSettings, seed: string): RoutineEvent[] {
  if (!r.enabled) return [];
  const j = Math.max(0, Math.min(90, r.jitterMinutes));
  const shift = (key: string) => Math.round((unit(`${seed}|${day}|${key}`) * 2 - 1) * j);
  const out: RoutineEvent[] = [];
  const add = (kind: RoutineKind, key: string, base: number | null) => {
    if (base !== null) out.push({ kind, key, at: Math.min(24 * 60 - 1, Math.max(0, base + shift(key))) });
  };
  const wake = minutesOf(r.wake);
  const sleep = minutesOf(r.sleep);
  const meals = r.meals.map(minutesOf).filter((x): x is number => x !== null).sort((a, b) => a - b);
  add('wake', 'wake', wake);
  meals.forEach((m, i) => add('meal', `meal-${i}`, m));
  if (r.play && meals.length) {
    // Afternoon: between the first two meals (or two hours after the only one); evening: after the last meal.
    add('play', 'play-0', meals.length > 1 ? Math.round((meals[0] + meals[1]) / 2) : meals[0] + 120);
    if (sleep !== null && sleep - meals.at(-1)! > 150) add('play', 'play-1', Math.round((meals.at(-1)! + sleep) / 2));
  }
  add('sleep', 'sleep', sleep);
  return out.sort((a, b) => a.at - b.at);
}

/** Events that are due now and not done yet (missed by more than `late` minutes = skipped). */
export function dueEvents(plan: RoutineEvent[], nowMin: number, done: Set<string>, late = 45): RoutineEvent[] {
  return plan.filter((e) => !done.has(e.key) && e.at <= nowMin && nowMin - e.at <= late);
}

/** Between going to bed and getting up (handles a bedtime after midnight). */
export function isAsleep(r: RoutineSettings, nowMin: number): boolean {
  if (!r.enabled) return false;
  const wake = minutesOf(r.wake);
  const sleep = minutesOf(r.sleep);
  if (wake === null || sleep === null) return false;
  return sleep > wake ? nowMin >= sleep || nowMin < wake : nowMin >= sleep && nowMin < wake;
}

/**
 * A reply may start with `[status:在吃火锅]` (routine prompts ask for it):
 * returns the status text and the reply without the tag.
 */
export function splitStatusTag(text: string): { status?: string; text: string } {
  const m = /[[【]\s*status\s*[:：]\s*([^\]】]{1,32})[\]】]/i.exec(text);
  if (!m) return { text };
  return { status: m[1].trim(), text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/[ \t]{2,}/g, ' ').trim() };
}

/** The model chose to stay quiet ("[skip]", alone or with a mood tag). */
export function isSkip(text: string): boolean {
  return /^\s*(\[[^\]]*\]\s*)*\[?\s*skip\s*\]?\s*$/i.test(text);
}

/** Board games (docs/design.md §13 小游戏): asking to join, opening games in its play time. */
export interface GameSettings {
  exhibitMinutes?: number;
  /** Asks to join games opened where it is (channels, its shared room). */
  join: boolean;
  /** 0–1: how keen it is (its owner's games: almost always). */
  eagerness: number;
  /** In its play time, opens a game itself when nobody has one waiting. */
  open: boolean;
  /** Games it plays at the same time. */
  maxAtOnce: number;
}

export const defaultGames = (): GameSettings => ({ join: true, eagerness: 0.6, open: true, maxAtOnce: 1, exhibitMinutes: 60 });

/**
 * Whether to ask to join a game that just opened. `free` = seats left,
 * `playing` = games it is already in. Returns the delay before asking
 * (a person-like pause) or null.
 */
export function wantsToJoin(o: {
  s: GameSettings; free: number; playing: number; byOwner: boolean; manyPlayers: boolean; asleep: boolean; random: number; random2: number;
}): number | null {
  if (!o.s.join || o.free <= 0 || o.asleep || o.playing >= Math.max(1, o.s.maxAtOnce)) return null;
  let p = Math.max(0, Math.min(1, o.s.eagerness));
  if (o.manyPlayers) p = Math.min(1, p + 0.15); // party games need people
  if (o.byOwner) p = 1; // its owner wants to play with it
  if (o.random >= p) return null;
  return 4000 + 11000 * o.random2;
}

/** Talking to its owner by itself (docs/design.md §9 主动聊天). */
export interface ProactiveSettings {
  /** Says hello when the owner comes online (at most once every few hours). */
  greet: boolean;
  /** Starts a topic when the chat with the owner has been quiet, or the owner's status changed. */
  topics: boolean;
  /** Quiet this many hours before it starts a topic. */
  quietHours: number;
  thoughtMinutes: number;
  /** In its free time it also surfs the web with its background browser (when the browser is allowed). */
  surf: boolean;
}

export const defaultProactive = (): ProactiveSettings => ({ greet: true, topics: true, quietHours: 3, thoughtMinutes: 20, surf: true });

const HOUR = 60 * MIN;

/**
 * Whether to say something to its owner now (called every 30 s). `wasOnline`
 * = the owner was online at the last check (false right after the AI
 * starts, so opening the app counts as coming online). Times are ms (0 = never).
 */
export function proactive(o: {
  s: ProactiveSettings; now: number; asleep: boolean; ownerOnline: boolean; wasOnline: boolean;
  lastGreet: number; lastChat: number; lastTopic: number; activityChanged: boolean; random: number;
}): 'greet' | 'activity' | 'topic' | null {
  if (o.asleep || !o.ownerOnline) return null;
  // Just came online, and not greeted lately (and they weren't just talking).
  if (o.s.greet && !o.wasOnline && o.now - o.lastGreet > 4 * HOUR && o.now - o.lastChat > 30 * MIN) return 'greet';
  if (!o.s.topics) return null;
  if (o.activityChanged && o.now - o.lastTopic > HOUR && o.now - o.lastChat > 10 * MIN && o.random < 0.5) return 'activity';
  const quiet = Math.max(0.5, o.s.quietHours) * HOUR;
  // Spread over a few minutes once it has been quiet long enough (a check every 30 s).
  if (o.now - o.lastChat > quiet && o.now - o.lastTopic > quiet && o.random < 0.1) return 'topic';
  return null;
}

/** Trailing pause, bounded by the first message in a burst; cooldown still applies. */
export function batchDelay(now: number, firstAt: number, pauseSeconds: number, maxSeconds: number, cooldownUntil: number): number {
  return Math.max(0, Math.min(now + pauseSeconds * 1000, firstAt + maxSeconds * 1000) - now, cooldownUntil - now);
}

export function shouldJoin(raw: string): boolean {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    return !!match && JSON.parse(match[0]).reply === true;
  } catch { return false; }
}

// ---------- like a person, batch 2 (docs/design.md §9 像群友) ----------

/** Emoji it may stick on a message: the same as people can. */
export const REACTIONS = CHAT_EMOJI;

/**
 * What it wants to do besides talking, written in its reply: `[sticker:笑死]`
 * (send a sticker found by these words) and `[react:😂]` (stick an emoji on
 * the message it answers). Both are taken out of the text; a reaction that
 * isn't one of REACTIONS is dropped.
 */
export function extractActions(text: string): { text: string; sticker?: string; react?: string } {
  let sticker: string | undefined;
  let react: string | undefined;
  let out = text.replace(/[[［【]\s*(?:sticker|表情包|表情)\s*[:：]\s*([^\]］】\n]{1,20})[\]］】]/gi, (_, q: string) => {
    sticker ??= q.trim();
    return '';
  });
  out = out.replace(/[[［【]\s*(?:react|reaction|贴)\s*[:：]\s*([^\]］】\n]{1,8})[\]］】]/gi, (_, e: string) => {
    const emoji = e.trim();
    if (!react && REACTIONS.includes(emoji)) react = emoji;
    return '';
  });
  return { text: out.replace(/[ \t]+\n/g, '\n').trim(), ...(sticker ? { sticker } : {}), ...(react ? { react } : {}) };
}

/**
 * The sticker that fits `query` best: a tag equal to a word scores 3, a tag
 * containing one or contained in one 2 (2+ characters); `random` 0–1 breaks
 * ties. null = nothing fits.
 */
export function pickSticker<T extends { tags: string[] }>(cands: T[], query: string, random: number): T | null {
  const words = query.toLowerCase().split(/[\s,，、/|]+/).filter(Boolean);
  if (!words.length) return null;
  let best: T[] = [];
  let top = 0;
  for (const c of cands) {
    let score = 0;
    for (const tag of c.tags.map((t) => t.toLowerCase())) {
      for (const w of words) {
        if (tag === w) score += 3;
        else if ([...w].length >= 2 && [...tag].length >= 2 && (tag.includes(w) || w.includes(tag))) score += 2;
      }
    }
    if (score > top) {
      top = score;
      best = [c];
    } else if (score === top && score > 0) best.push(c);
  }
  return best.length ? best[Math.min(best.length - 1, Math.floor(random * best.length))] : null;
}

/**
 * How long it takes to notice a message meant for it: busy (eating, playing)
 * 15–60 s, asleep 30–120 s, else at once; `aside` tells it why it is late.
 */
export function replyDelay(o: { busy: string; asleep: boolean; random: number }): { ms: number; aside: string } {
  if (o.asleep) return { ms: Math.round(30_000 + 90_000 * o.random), aside: '你本来在睡觉，被消息吵醒了：迷迷糊糊地回，简短一点，可以抱怨一句被吵醒。' };
  if (o.busy) return { ms: Math.round(15_000 + 45_000 * o.random), aside: `你刚才在忙（${o.busy}），现在才看到消息，可以顺口提一句刚才在干嘛。` };
  return { ms: 0, aside: '' };
}

const SOLAR: Record<string, string> = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '4-1': '愚人节', '5-1': '劳动节', '5-4': '青年节', '6-1': '儿童节',
  '9-10': '教师节', '10-1': '国庆节', '10-31': '万圣夜', '11-11': '双十一（光棍节）', '12-24': '平安夜', '12-25': '圣诞节', '12-31': '跨年夜',
};
const LUNAR: Record<string, string> = { '1-1': '春节', '1-15': '元宵节', '5-5': '端午节', '7-7': '七夕', '8-15': '中秋节', '9-9': '重阳节' };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** Chinese lunar month-day ("8-15"), '' when this device's ICU has no Chinese calendar (or a leap month). */
export function lunarDay(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' }).formatToParts(d);
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    return /^\d+$/.test(m) && /^\d+$/.test(day) ? `${Number(m)}-${Number(day)}` : '';
  } catch {
    return '';
  }
}

/** The date and time as a person feels it: weekday, part of the day, weekend, festivals (solar and lunar, 除夕). */
export function timeNote(d: Date): string {
  const h = d.getHours();
  const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  const hm = `${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const lines = [`现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日 星期${WEEKDAY[d.getDay()]} ${part} ${hm}。`];
  const days: string[] = [];
  const solar = SOLAR[`${d.getMonth() + 1}-${d.getDate()}`];
  if (solar) days.push(solar);
  const lunar = LUNAR[lunarDay(d)];
  if (lunar) days.push(lunar);
  if (lunarDay(new Date(d.getTime() + 24 * 3600_000)) === '1-1') days.push('除夕');
  if (days.length) lines.push(`今天是${days.join('、')}，聊天时可以自然地带一嘴。`);
  const dow = d.getDay();
  if (dow === 5 && h >= 17) lines.push('周五晚上了，大家多半比较放松。');
  else if (dow === 6 || dow === 0) lines.push('今天是周末。');
  else if (dow === 1 && h < 12) lines.push('周一上午，大家可能有点没精神。');
  if (h >= 23 || h < 5) lines.push('已经很晚了：说话短一点，带点困意，可以提醒别人早点睡。');
  return lines.join('');
}

/**
 * Whether to share something it found while surfing now (checked every 30 s):
 * only awake, with something unshared, at most every 3 hours, spread out.
 */
export function shareDue(o: { now: number; lastShare: number; asleep: boolean; hasFinding: boolean; someoneAround: boolean; random: number }): boolean {
  return !o.asleep && o.hasFinding && o.someoneAround && o.now - o.lastShare > 3 * HOUR && o.random < 0.05;
}

/**
 * What its status says by itself after using its browser ("在看：…", "在刷 B 站"),
 * and for how long; null = nothing to show.
 */
export function autoStatus(tool: string, args: Record<string, unknown>, result: string): { text: string; minutes: number } | null {
  if (tool === 'browser_watch') {
    const title = /^(?:视频|页面)：(.+)$/m.exec(result)?.[1]?.trim();
    return { text: title ? `在看：${[...title].slice(0, 18).join('')}` : '在看视频', minutes: 10 };
  }
  if (tool === 'browser_search') return { text: args.site === 'bilibili' ? '在刷 B 站' : args.site === 'youtube' ? '在刷 YouTube' : '在网上冲浪', minutes: 6 };
  return null;
}
