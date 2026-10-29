// AI portrait packs: one image per emotion (docs/design.md §9). A pack is a
// map from emotion key to image URL; missing emotions fall back along FALLBACK
// and finally to `neutral`. The default pack (defaultPack.ts) ships with the
// client and is used by every AI that has no pack of its own.

export const MOODS = [
  'neutral', 'happy', 'laugh', 'smug', 'shy', 'love', 'sad', 'cry', 'worried',
  'scared', 'angry', 'surprised', 'thinking', 'confused', 'speechless', 'sleepy',
] as const;
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

/** Parses the `[mood:xxx]` tag a reply starts with; returns the mood and the text without it. */
export function splitMoodTag(text: string): { mood: Mood; text: string } {
  const m = /^\s*\[mood:([a-z]+)\]\s*/i.exec(text);
  const key = m?.[1].toLowerCase();
  if (!m || !key || !(MOODS as readonly string[]).includes(key)) return { mood: 'neutral', text };
  return { mood: key as Mood, text: text.slice(m[0].length) };
}
