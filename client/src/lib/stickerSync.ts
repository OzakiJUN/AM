// Copies my stickers to all my servers in the background (docs/design.md
// §11, §7 资料同步): a sticker I have on one server is added on every other
// server I'm on, at the destination server’s sync rate so it doesn't eat the
// bandwidth of a small relay. Files the other server's shared library
// already has are collected there instead of uploaded. Deleting a sticker
// is not copied. What was copied is remembered on this device, so a sticker
// deleted on purpose on one server doesn't come back. Planning is pure in
// lib/stickerCopy.ts.
import { create } from 'zustand';
import { ApiError, errorText } from './errors';
import { usePrefs } from './prefs';
import { isFinal, planCopies, type CopySticker, type CopyTask } from './stickerCopy';
import type { Session } from './session';
import { loadStickers } from './stickers';
import { session, useApp } from './store';

const DONE_KEY = 'am-sticker-sync-done';
const RETRY_MS = 2 * 60_000;
const EVERY_MS = 15 * 60_000;

interface StickerSyncState {
  running: boolean;
  /** Stickers still to copy in this round. */
  left: number;
  /** Time the last round finished with nothing left. */
  last: number | null;
  /** Last error per target server. */
  errors: Record<string, string>;
}

export const useStickerSync = create<StickerSyncState>(() => ({ running: false, left: 0, last: null, errors: {} }));

function loadDone(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
const done = loadDone();
function markDone(key: string) {
  done.add(key);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* storage full / blocked */
  }
}

/** Forgets what was copied to or from a server (it was reinstalled or removed). */
export function forgetStickerServer(id: string) {
  for (const k of [...done]) if (k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) done.delete(k);
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    /* ignore */
  }
}

const ready = (s: Session | undefined): s is Session => !!s && s.view.status === 'online' && !!s.view.me;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Starts a round soon (my stickers changed, or a server came online). */
export function kickStickerSync(ms = 5_000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runStickerSync();
  }, ms);
}

function setError(target: string, msg: string | null) {
  useStickerSync.setState((st) => {
    const errors = { ...st.errors };
    if (msg) errors[target] = msg;
    else delete errors[target];
    return { errors };
  });
}

/** One round: plans and copies everything missing, one sticker at a time. */
export async function runStickerSync(): Promise<void> {
  const prefs = usePrefs.getState();
  if (!prefs.profileSync || !prefs.stickerSync) return;
  if (useStickerSync.getState().running) {
    kickStickerSync(30_000);
    return;
  }
  const servers = useApp.getState().servers.map((r) => r.id).filter((id) => ready(session(id)));
  if (servers.length < 2) return;
  useStickerSync.setState({ running: true });
  let retry = false;
  const changed = new Set<string>();
  try {
    const lists: Record<string, CopySticker[]> = {};
    for (const id of servers) {
      try {
        lists[id] = await session(id)!.listStickers();
      } catch {
        retry = true;
      }
    }
    const plan = planCopies(lists, done);
    useStickerSync.setState({ left: plan.length });
    // Files the target's library already has: collect instead of upload.
    const known: Record<string, Record<string, string>> = {};
    for (const to of new Set(plan.map((t) => t.to))) {
      const shas = plan.filter((t) => t.to === to && !t.sticker.private).map((t) => t.sticker.sha256);
      known[to] = {};
      for (let i = 0; i < shas.length; i += 200) {
        try {
          Object.assign(known[to], await session(to)!.lookupStickers(shas.slice(i, i + 200)));
        } catch {
          /* just upload them */
        }
      }
    }
    const stopped = new Set<string>();
    for (const task of plan) {
      if (!usePrefs.getState().stickerSync || !usePrefs.getState().profileSync) break;
      if (!stopped.has(task.to)) {
        const r = await copyOne(task, known[task.to] ?? {});
        if (r === 'ok') {
          changed.add(task.to);
          setError(task.to, null);
        } else if (r === 'stop') {
          stopped.add(task.to);
        } else if (r === 'retry') {
          stopped.add(task.to);
          retry = true;
        }
      }
      useStickerSync.setState((st) => ({ left: Math.max(0, st.left - 1) }));
    }
    if (!retry && !stopped.size) useStickerSync.setState({ last: Date.now() });
  } finally {
    useStickerSync.setState({ running: false, left: 0 });
    for (const id of changed) void loadStickers(id, true).catch(() => {});
  }
  if (retry) kickStickerSync(RETRY_MS);
}

async function copyOne(task: CopyTask, known: Record<string, string>): Promise<'ok' | 'skip' | 'stop' | 'retry'> {
  const src = session(task.from);
  const dst = session(task.to);
  if (!ready(src) || !ready(dst)) return 'retry';
  const st = task.sticker;
  try {
    const lib = st.private ? '' : known[st.sha256];
    if (lib) {
      await dst.collectSticker(lib);
      if (st.tags.length) await dst.editLibraryTags(lib, st.tags.slice(0, 20), []).catch(() => {});
    } else {
      const blob = await src.t.mediaBytes(`/api/v1/media/${st.mediaId}`);
      const info = await dst.upload(new File([blob], `sticker-${st.id}`, { type: blob.type }), true);
      await dst.addSticker(info.id.toString(), st.tags.slice(0, st.private ? 10 : 20), st.private);
    }
    markDone(task.key);
    return 'ok';
  } catch (e) {
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'sticker_limit' || code === 'sticker_library_off' || code === 'no_permission') {
      setError(task.to, errorText(e));
      return 'stop';
    }
    if (isFinal(code)) {
      // This picture can't go there (blocked, not an image, too big): leave it.
      markDone(task.key);
      return 'skip';
    }
    setError(task.to, errorText(e));
    return 'retry';
  }
}

/** Hooks the copying onto my servers (call once at start). */
export function startStickerSync() {
  const online = new Set<string>();
  const check = () => {
    let came = false;
    for (const rec of useApp.getState().servers) {
      const r = ready(session(rec.id));
      if (r && !online.has(rec.id)) came = true;
      if (r) online.add(rec.id);
      else online.delete(rec.id);
    }
    if (came) kickStickerSync(10_000);
  };
  useApp.subscribe(check);
  check();
  setInterval(() => kickStickerSync(0), EVERY_MS);
}
