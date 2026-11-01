// @-mentions in the composer and in messages. Pure, tested.

/** The "@xx" being typed just before the caret: where it starts and what was typed after "@". */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]{0,20})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Replaces the "@query" at `start`..`caret` with "@name " and returns the new text and caret. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const ins = `@${name} `;
  return { text: text.slice(0, start) + ins + text.slice(caret), caret: start + ins.length };
}

/** Ids of the people picked from the list whose "@name" is still in the text. */
export function mentionedIds(text: string, picked: Map<string, string>): string[] {
  return [...picked].filter(([, name]) => text.includes(`@${name}`)).map(([id]) => id);
}

/** People whose name or username matches what was typed (best first). */
export function matchPeople<T extends { id: string; name: string; username: string }>(people: T[], query: string, limit = 8): T[] {
  const q = query.toLowerCase();
  const score = (p: T) => {
    const n = p.name.toLowerCase();
    const u = p.username.toLowerCase();
    if (!q) return 1;
    if (n.startsWith(q) || u.startsWith(q)) return 3;
    if (n.includes(q) || u.includes(q)) return 2;
    return 0;
  };
  return people.map((p) => [p, score(p)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p);
}

/** Splits a message into plain text and "@name" parts for the mentioned people (to highlight them). */
export function mentionParts(text: string, names: string[]): { text: string; mention?: boolean }[] {
  const list = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return [{ text }];
  const esc = list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts: { text: string; mention?: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(`@(?:${esc.join('|')})`, 'g'))) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], mention: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
