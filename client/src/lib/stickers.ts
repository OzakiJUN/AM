// My sticker collection per server (docs/design.md §11), loaded on first use.
import { create } from 'zustand';
import type { Sticker } from './session';
import { session } from './store';

interface StickerState {
  byServer: Record<string, Sticker[] | undefined>;
}

export const useStickers = create<StickerState>(() => ({ byServer: {} }));

const put = (serverId: string, f: (l: Sticker[]) => Sticker[]) =>
  useStickers.setState((st) => ({ byServer: { ...st.byServer, [serverId]: f(st.byServer[serverId] ?? []) } }));

export async function loadStickers(serverId: string, force = false) {
  if (!force && useStickers.getState().byServer[serverId]) return;
  const list = await session(serverId)!.listStickers();
  useStickers.setState((st) => ({ byServer: { ...st.byServer, [serverId]: list } }));
}

/** Uploads pictures and adds them as stickers (one by one, newest first). Returns how many were added. */
export async function importStickers(serverId: string, files: File[], onProgress?: (done: number) => void): Promise<number> {
  const s = session(serverId)!;
  let n = 0;
  for (const f of files) {
    const info = await s.upload(f);
    if (!info.isImage) throw new Error(`「${f.name}」不是图片`);
    const st = await s.addSticker(info.id.toString());
    put(serverId, (l) => [st, ...l.filter((x) => x.id !== st.id)]);
    onProgress?.(++n);
  }
  return n;
}

export async function setTags(serverId: string, id: string, tags: string[]) {
  const st = await session(serverId)!.setStickerTags(id, tags);
  put(serverId, (l) => l.map((x) => (x.id === id ? st : x)));
}

export async function removeSticker(serverId: string, id: string) {
  await session(serverId)!.deleteSticker(id);
  put(serverId, (l) => l.filter((x) => x.id !== id));
}
