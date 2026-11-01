// Copying my stickers between my servers (docs/design.md §7 资料同步, §11):
// what still has to go where. Pure, unit-tested; lib/stickerSync.ts runs it.

/** What the planner needs to know about a sticker. */
export interface CopySticker {
  id: string;
  mediaId: string;
  sha256: string;
  tags: string[];
  private: boolean;
  /** Added at (unix ms); new ones wait a little so tags / private can be set first. */
  createdAt: number;
}

/** A new sticker is copied only after this long (time to tag it or make it private). */
export const SETTLE_MS = 2 * 60_000;

export interface CopyTask {
  from: string;
  to: string;
  sticker: CopySticker;
  /** Key for the "done" record: "from|sticker id|to". */
  key: string;
}

export const copyKey = (from: string, stickerId: string, to: string) => `${from}|${stickerId}|${to}`;

/**
 * Plans copies: every sticker on any server goes to every other server that
 * doesn't have that file yet. Skips stickers already copied (or tried for
 * good) per `done`, and plans each file only once per target even when
 * several servers have it. Oldest first, so the order stays the same.
 */
export function planCopies(lists: Record<string, CopySticker[]>, done: Set<string>, now = Date.now()): CopyTask[] {
  const out: CopyTask[] = [];
  const servers = Object.keys(lists).sort();
  for (const to of servers) {
    const have = new Set(lists[to].map((s) => s.sha256).filter(Boolean));
    for (const from of servers) {
      if (from === to) continue;
      for (const st of [...lists[from]].reverse()) {
        const key = copyKey(from, st.id, to);
        if (!st.sha256 || have.has(st.sha256) || done.has(key) || now - st.createdAt < SETTLE_MS) continue;
        have.add(st.sha256);
        out.push({ from, to, sticker: st, key });
      }
    }
  }
  return out;
}

/** Errors that will not go away by trying again (the target refuses): stop for that target. */
export function isFinal(code: string): boolean {
  return /^(sticker_limit|blocked_media|not_image|bad_image|too_large|sticker_library_off|no_permission)$/.test(code);
}

/** Stickers made after SETTLE_MS: is any still too new to copy? */
export function waiting(lists: Record<string, CopySticker[]>, now = Date.now()): boolean {
  return Object.values(lists).some((l) => l.some((s) => now - s.createdAt < SETTLE_MS));
}

/**
 * Copies this device made of stickers that are private now on the server
 * they came from, but still shared where they were copied to: those copies
 * become private too (making something private must not leave it public
 * elsewhere). Matched by file.
 */
export function privacyFixes(lists: Record<string, CopySticker[]>, done: Set<string>): { to: string; stickerId: string }[] {
  const out: { to: string; stickerId: string }[] = [];
  const servers = Object.keys(lists).sort();
  for (const from of servers) {
    for (const st of lists[from]) {
      if (!st.private || !st.sha256) continue;
      for (const to of servers) {
        if (to === from || !done.has(copyKey(from, st.id, to))) continue;
        for (const d of lists[to]) {
          if (d.sha256 === st.sha256 && !d.private && !out.some((x) => x.to === to && x.stickerId === d.id)) out.push({ to, stickerId: d.id });
        }
      }
    }
  }
  return out;
}
