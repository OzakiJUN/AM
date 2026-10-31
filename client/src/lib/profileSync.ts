// Copying "my profile" between servers (docs/design.md §7, 资料同步). Each
// self-hosted server keeps its own account; the client carries the profile
// along: display name, avatar, signature, invisible / activity and the
// profile widget board (pictures are uploaded again to the other server).
// Messages, channels, guestbook entries and stats stay on their server.
//
// This file is the engine, written against a small interface (SyncSide) so
// it can be unit-tested; lib/sync.ts connects it to the live sessions.
import type { Activity } from './types';
import type { LayoutModel } from './widgets';

export type Part = 'profile' | 'presence' | 'board';
export const PARTS: Part[] = ['profile', 'presence', 'board'];

/** One server as the sync engine sees it. */
export interface SyncSide {
  id: string;
  me(): { name: string; bio: string; avatar?: string } | undefined;
  presence(): { invisible: boolean; activity?: Activity };
  getBoard(): Promise<LayoutModel>;
  saveBoard(l: LayoutModel): Promise<void>;
  setProfile(p: { displayName: string; bio: string; avatarMediaId?: string }): Promise<void>;
  setPresence(invisible: boolean, activity?: Activity): Promise<void>;
  /** Bytes of a media path on this server. */
  mediaBytes(path: string): Promise<Blob>;
  /** Uploads an image; returns its media id on this server. */
  upload(data: Blob, name: string): Promise<string>;
}

/** Media ids a layout uses (widget pictures, the background, snapshots). */
export function layoutMedia(l: LayoutModel): string[] {
  const out = new Set<string>();
  const add = (id: unknown) => typeof id === 'string' && id && out.add(id);
  for (const w of l.widgets) {
    add(w.config.media_id);
    if (Array.isArray(w.config.media_ids)) w.config.media_ids.forEach(add);
    add(w.snapshotMediaId);
  }
  add(l.background.mediaId);
  return [...out];
}

/** The same layout with media ids replaced (ids missing from `map` are dropped). */
export function remapLayout(l: LayoutModel, map: Record<string, string>): LayoutModel {
  const one = (id: unknown) => (typeof id === 'string' && map[id]) || '';
  return {
    ...l,
    widgets: l.widgets.map((w) => {
      const config = { ...w.config };
      if ('media_id' in config) config.media_id = one(config.media_id);
      if (Array.isArray(config.media_ids)) config.media_ids = config.media_ids.map(one).filter(Boolean);
      return { ...w, config, snapshotMediaId: w.snapshotMediaId ? one(w.snapshotMediaId) || undefined : undefined };
    }),
    background: l.background.mediaId
      ? map[l.background.mediaId]
        ? { ...l.background, mediaId: map[l.background.mediaId] }
        : { ...l.background, kind: '', mediaId: undefined }
      : l.background,
  };
}

/**
 * Remembers which media were already copied (source server + id -> id on
 * the target), so an unchanged avatar or picture is not uploaded again.
 */
export interface MediaCache {
  get(src: string, id: string, dst: string): string | undefined;
  set(src: string, id: string, dst: string, dstId: string): void;
  drop(dst: string): void;
}

export function memoryCache(): MediaCache {
  const m = new Map<string, string>();
  return {
    get: (s, id, d) => m.get(`${s}|${id}|${d}`),
    set: (s, id, d, v) => void m.set(`${s}|${id}|${d}`, v),
    drop: (d) => [...m.keys()].filter((k) => k.endsWith(`|${d}`)).forEach((k) => m.delete(k)),
  };
}

const mediaPath = (id: string) => `/api/v1/media/${id}`;

async function copyMedia(src: SyncSide, dst: SyncSide, id: string, cache: MediaCache): Promise<string> {
  const hit = cache.get(src.id, id, dst.id);
  if (hit) return hit;
  const blob = await src.mediaBytes(mediaPath(id));
  const out = await dst.upload(blob, `profile-${id}`);
  cache.set(src.id, id, dst.id, out);
  return out;
}

/** "/api/v1/media/123" -> "123". */
function mediaIdOf(path?: string) {
  const m = /\/api\/v1\/media\/(\d+)/.exec(path ?? '');
  return m ? m[1] : '';
}

/** Copies the given parts of my profile from one server to another. */
export async function copyParts(src: SyncSide, dst: SyncSide, parts: Part[], cache: MediaCache): Promise<void> {
  const run = async () => {
    if (parts.includes('profile')) {
      const me = src.me();
      if (me) {
        const avatar = mediaIdOf(me.avatar);
        await dst.setProfile({
          displayName: me.name, bio: me.bio,
          avatarMediaId: avatar ? await copyMedia(src, dst, avatar, cache) : '0',
        });
      }
    }
    if (parts.includes('presence')) {
      const p = src.presence();
      await dst.setPresence(p.invisible, p.activity);
    }
    if (parts.includes('board')) {
      const l = await src.getBoard();
      const map: Record<string, string> = {};
      for (const id of layoutMedia(l)) map[id] = await copyMedia(src, dst, id, cache);
      const target = await dst.getBoard();
      await dst.saveBoard({ ...remapLayout(l, map), version: target.version });
    }
  };
  try {
    await run();
  } catch (e) {
    // A cached copy may have been cleaned up on the target: retry once fresh.
    if (!(e instanceof Error) || !/media_not_found|文件不存在/.test(`${(e as { code?: string }).code ?? ''} ${e.message}`)) throw e;
    cache.drop(dst.id);
    await run();
  }
}

/** Pending work: for each target server, which parts to copy from where. */
export type Pending = Record<string, Partial<Record<Part, { from: string; at: number }>>>;

/**
 * Records a change made on `source`: every other server gets it (newest
 * change wins per part), and nothing older is copied back onto `source`.
 */
export function markChanged(p: Pending, source: string, parts: Part[], targets: string[], now = Date.now()): Pending {
  const out: Pending = {};
  for (const [t, v] of Object.entries(p)) out[t] = { ...v };
  for (const part of parts) {
    if (out[source]) delete out[source][part];
    for (const t of targets) {
      if (t === source) continue;
      out[t] = { ...out[t], [part]: { from: source, at: now } };
    }
  }
  for (const t of Object.keys(out)) if (!Object.keys(out[t]).length) delete out[t];
  return out;
}

/** Groups a target's pending parts by source server. */
export function bySource(entry: Pending[string]): Record<string, Part[]> {
  const out: Record<string, Part[]> = {};
  for (const part of PARTS) {
    const e = entry[part];
    if (e) (out[e.from] ??= []).push(part);
  }
  return out;
}
