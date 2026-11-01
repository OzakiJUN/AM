// My sticker collection per server and the server's shared library
// (docs/design.md §11). The collection is loaded on first use; changes made
// here also queue copying my stickers to my other servers (lib/stickerSync.ts).
import { create } from 'zustand';
import type { LibrarySticker, Sticker } from './session';
import { session } from './store';
import { kickStickerSync } from './stickerSync';

interface StickerState {
  byServer: Record<string, Sticker[] | undefined>;
}

export const useStickers = create<StickerState>(() => ({ byServer: {} }));

const put = (serverId: string, f: (l: Sticker[]) => Sticker[]) =>
  useStickers.setState((st) => ({ byServer: { ...st.byServer, [serverId]: f(st.byServer[serverId] ?? []) } }));

/** Puts a sticker first in the list (or replaces it); drops `gone` (merged away). */
function upsert(serverId: string, st: Sticker, gone?: string) {
  put(serverId, (l) => [st, ...l.filter((x) => x.id !== st.id && x.id !== gone)]);
}

export async function loadStickers(serverId: string, force = false) {
  if (!force && useStickers.getState().byServer[serverId]) return;
  const list = await session(serverId)!.listStickers();
  useStickers.setState((st) => ({ byServer: { ...st.byServer, [serverId]: list } }));
}

/**
 * Uploads pictures and adds them as stickers (one by one). priv: this batch
 * is private (else the server default: shared). Returns how many were added.
 */
export async function importStickers(serverId: string, files: File[], priv: boolean, onProgress?: (done: number) => void): Promise<number> {
  const s = session(serverId)!;
  let n = 0;
  try {
    for (const f of files) {
      const info = await s.upload(f);
      if (!info.isImage) throw new Error(`「${f.name}」不是图片`);
      const st = await s.addSticker(info.id.toString(), [], priv || undefined);
      upsert(serverId, st);
      onProgress?.(++n);
    }
  } finally {
    if (n) kickStickerSync();
  }
  return n;
}

/** Imports pictures with their tags (a workshop sticker pack) one by one. Returns how many were added. */
export async function importStickerFiles(serverId: string, list: { file: File; tags: string[] }[], onProgress?: (done: number) => void): Promise<number> {
  const s = session(serverId)!;
  let n = 0;
  try {
    for (const { file, tags } of list) {
      const info = await s.upload(file);
      upsert(serverId, await s.addSticker(info.id.toString(), tags));
      onProgress?.(++n);
    }
  } finally {
    if (n) kickStickerSync();
  }
  return n;
}

/** A picture from a chat (channel or DM) into my collection, shared like any other (server default). */
export async function addFromChat(serverId: string, mediaId: string) {
  const st = await session(serverId)!.addSticker(mediaId);
  upsert(serverId, st);
  kickStickerSync();
  return st;
}

export async function setTags(serverId: string, id: string, tags: string[]) {
  const st = await session(serverId)!.setStickerTags(id, tags);
  upsert(serverId, st);
}

export async function setPrivate(serverId: string, id: string, priv: boolean) {
  const st = await session(serverId)!.setStickerPrivate(id, priv);
  // Making it shared may merge it into a sticker I already had for that picture.
  put(serverId, (l) => {
    const i = l.findIndex((x) => x.id === id);
    const rest = l.filter((x) => x.id !== id && x.id !== st.id);
    if (i < 0) return [st, ...rest];
    rest.splice(Math.min(i, rest.length), 0, st);
    return rest;
  });
  return st;
}

export async function removeSticker(serverId: string, id: string) {
  await session(serverId)!.deleteSticker(id);
  put(serverId, (l) => l.filter((x) => x.id !== id));
}

// ---- the shared library ----

export async function collect(serverId: string, item: LibrarySticker) {
  const st = await session(serverId)!.collectSticker(item.id);
  upsert(serverId, st);
  kickStickerSync();
  return st;
}

/** Adds / takes off tags on a library picture; my sticker for it (if any) gets the new tags too. */
export async function editLibraryTags(serverId: string, item: LibrarySticker, add: string[], remove: string[]) {
  const out = await session(serverId)!.editLibraryTags(item.id, add, remove);
  put(serverId, (l) => l.map((x) => (x.libraryId === out.id ? { ...x, tags: out.tags, myTags: out.myTags } : x)));
  return out;
}
