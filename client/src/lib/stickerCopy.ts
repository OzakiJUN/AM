// Copying my stickers between my servers (docs/design.md §7 资料同步, §11):
// what still has to go where. Pure, unit-tested; lib/stickerSync.ts runs it.

/** What the planner needs to know about a sticker. */
export interface CopySticker {
  id: string;
  mediaId: string;
  sha256: string;
  tags: string[];
  private: boolean;
}

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
export function planCopies(lists: Record<string, CopySticker[]>, done: Set<string>): CopyTask[] {
  const out: CopyTask[] = [];
  const servers = Object.keys(lists).sort();
  for (const to of servers) {
    const have = new Set(lists[to].map((s) => s.sha256).filter(Boolean));
    for (const from of servers) {
      if (from === to) continue;
      for (const st of [...lists[from]].reverse()) {
        const key = copyKey(from, st.id, to);
        if (!st.sha256 || have.has(st.sha256) || done.has(key)) continue;
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
