// AI portrait packs: one image per emotion (docs/design.md §9). A pack is a
// map from emotion key to image URL; missing emotions fall back along FALLBACK
// and finally to `neutral`. The default pack (defaultPack.ts) ships with the
// client and is used by every AI that has no pack of its own.

export const MOODS = [
  'neutral', 'happy', 'laugh', 'smug', 'shy', 'love', 'sad', 'cry', 'worried',
  'scared', 'angry', 'surprised', 'thinking', 'confused', 'speechless', 'sleepy',
] as const;
/** Names shown in the pack editor. */
export const MOOD_LABEL: Record<(typeof MOODS)[number], string> = {
  neutral: '平静', happy: '开心', laugh: '大笑', smug: '得意', shy: '害羞', love: '喜欢', sad: '难过', cry: '哭',
  worried: '担心', scared: '害怕', angry: '生气', surprised: '惊讶', thinking: '思考', confused: '疑惑', speechless: '无语', sleepy: '困',
};
/** States the client shows by itself (not chosen by the model). */
export const STATES = ['typing', 'offline'] as const;

export type Mood = (typeof MOODS)[number] | (typeof STATES)[number];
export type Pack = Partial<Record<Mood, string>>;

const FALLBACK: Partial<Record<Mood, Mood>> = {
  laugh: 'happy', smug: 'happy', love: 'shy', cry: 'sad', worried: 'sad', scared: 'surprised',
  confused: 'thinking', speechless: 'confused', typing: 'thinking',
};

const KEYS = new Set<string>([...MOODS, ...STATES]);

/**
 * Builds a pack from file names (or paths) and URLs. Names may carry a common
 * prefix ("dafeiyu_happy.png" -> happy); unknown names are ignored.
 */
export function packFromFiles(files: Record<string, string>): Pack {
  const pack: Pack = {};
  for (const [path, url] of Object.entries(files)) {
    const base = path.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
    const key = KEYS.has(base) ? base : base.split(/[_\-\s.]/).pop()!;
    if (KEYS.has(key)) pack[key as Mood] = url;
  }
  return pack;
}

/**
 * An AI's own pack as the server keeps it (mood -> URL). Only known moods
 * count, and it needs a `neutral` picture (every fallback ends there);
 * without one the AI uses the default pack (null).
 */
export function ownPack(images: Record<string, string>): Pack | null {
  const pack: Pack = {};
  for (const [k, url] of Object.entries(images)) if (KEYS.has(k) && url) pack[k as Mood] = url;
  return pack.neutral ? pack : null;
}

export interface Resolved {
  src: string;
  /** No offline image: show neutral greyed out instead. */
  grey: boolean;
}

/** The image for a mood, following the fallbacks. */
export function resolveMood(pack: Pack, mood: Mood): Resolved | null {
  if (mood === 'offline' && !pack.offline) {
    return pack.neutral ? { src: pack.neutral, grey: true } : null;
  }
  for (let m: Mood | undefined = mood, n = 0; m && n < 6; m = FALLBACK[m], n++) {
    if (pack[m]) return { src: pack[m]!, grey: false };
  }
  return pack.neutral ? { src: pack.neutral, grey: false } : null;
}

/** Words models use instead of our keys (English synonyms and Chinese). */
const MOOD_ALIAS: Record<string, (typeof MOODS)[number]> = {
  calm: 'neutral', normal: 'neutral', 平静: 'neutral', 普通: 'neutral', 一般: 'neutral',
  joy: 'happy', glad: 'happy', excited: 'happy', cheerful: 'happy', 开心: 'happy', 高兴: 'happy', 兴奋: 'happy', 愉快: 'happy',
  lol: 'laugh', 大笑: 'laugh', 哈哈: 'laugh', 得意: 'smug', proud: 'smug', 傲娇: 'smug',
  embarrassed: 'shy', blush: 'shy', 害羞: 'shy', 脸红: 'shy', 喜欢: 'love', 爱: 'love', affection: 'love',
  unhappy: 'sad', down: 'sad', 难过: 'sad', 伤心: 'sad', 失落: 'sad', crying: 'cry', 哭: 'cry', 大哭: 'cry',
  anxious: 'worried', nervous: 'worried', 担心: 'worried', 紧张: 'worried', afraid: 'scared', fear: 'scared', 害怕: 'scared',
  mad: 'angry', annoyed: 'angry', 生气: 'angry', 愤怒: 'angry', 不爽: 'angry', shocked: 'surprised', 惊讶: 'surprised', 吃惊: 'surprised',
  curious: 'thinking', 思考: 'thinking', 想想: 'thinking', puzzled: 'confused', 疑惑: 'confused', 困惑: 'confused',
  speechless: 'speechless', 无语: 'speechless', tired: 'sleepy', 困: 'sleepy', 累: 'sleepy', 犯困: 'sleepy',
};

/** A mood word from a model: our key, a synonym, or undefined. */
export function moodKey(word: string): (typeof MOODS)[number] | undefined {
  const w = word.trim().toLowerCase();
  if ((MOODS as readonly string[]).includes(w)) return w as (typeof MOODS)[number];
  return MOOD_ALIAS[w];
}

const BARE = /[\[【]\s*([^\]】\s]{1,12})\s*[\]】]/g;
const TAG = /[\[【(（]\s*(?:mood|心情|情绪|表情)\s*[:：=]\s*([^\]】)）\s]{1,16})\s*[\]】)）]/gi;

/**
 * Finds the mood tag in a reply (`[mood:happy]`, ideally at the start, but
 * models also put it at the end, use full-width brackets or a synonym) and
 * returns the mood and the text with every tag removed. No usable tag = neutral.
 */
export function splitMoodTag(text: string): { mood: Mood; text: string } {
  let mood: Mood | undefined;
  let found = false;
  let rest = text.replace(TAG, (_all, word: string) => {
    found = true;
    mood ??= moodKey(word);
    return ' ';
  });
  // Models also drop the "mood:" and write just "[laugh]" / "【开心】": taken
  // only when the brackets hold nothing but a mood name or synonym.
  rest = rest.replace(BARE, (all, word: string) => {
    const m = moodKey(word);
    if (!m) return all;
    found = true;
    mood ??= m;
    return ' ';
  });
  if (!found) return { mood: 'neutral', text };
  return { mood: mood ?? 'neutral', text: rest.replace(/[ \t]{2,}/g, ' ').trim() };
}

// ---- poking the portrait (docs/design.md §9 戳一戳) ----

export type PokePart = 'head' | 'face' | 'body' | 'feet';

/** Which part of a half-body portrait a point is on, by its height in the picture (0 = top). */
export function pokePart(fy: number): PokePart {
  return fy < 0.2 ? 'head' : fy < 0.42 ? 'face' : fy < 0.78 ? 'body' : 'feet';
}

/** The message a poke sends (the AI reacts to "[戳一戳] …" in character). */
export function pokeText(part: PokePart, name: string): string {
  return `[戳一戳] ${{ head: `摸了摸${name}的头`, face: `戳了戳${name}的脸`, body: `拍了拍${name}`, feet: `绊了${name}一下` }[part]}`;
}

/** Where a picture drawn with object-fit: contain, object-position: top centre sits in its box. */
export function containedRect(boxW: number, boxH: number, natW: number, natH: number): { x: number; y: number; w: number; h: number } {
  const k = Math.min(boxW / natW, boxH / natH);
  const w = natW * k;
  return { x: (boxW - w) / 2, y: 0, w, h: natH * k };
}
