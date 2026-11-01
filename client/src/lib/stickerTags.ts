// Sticker tags typed by hand (until automatic recognition exists). Pure, tested.

const MAX_TAGS = 10;
const MAX_LEN = 20;

/** "开心, 狗头 #doge、开心" -> ["开心", "狗头", "doge"] (same limits as the server). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,，、;；\s#]+/)) {
    const t = raw.trim().slice(0, MAX_LEN);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

export const tagsText = (tags: string[]) => tags.join('、');

/** Stickers whose tags match the search (all words must match some tag); untagged ones only without a search. */
export function searchStickers<T extends { tags: string[] }>(list: T[], query: string): T[] {
  const words = parseTags(query).map((w) => w.toLowerCase());
  if (!words.length) return list;
  return list.filter((s) => words.every((w) => s.tags.some((t) => t.toLowerCase().includes(w))));
}
