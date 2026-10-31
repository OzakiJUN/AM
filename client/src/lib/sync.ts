// Keeps "my profile" the same on all my servers (docs/design.md §7, 资料同步).
// A change on one server (name, avatar, signature, invisible / activity,
// profile board) is queued for every other server and copied a while after
// the last change (prefs.syncDelay), newest change winning. The queue is
// saved on this device, so changes made while a server is offline are
// copied when it comes back. The copying itself is lib/profileSync.ts.
import { create } from 'zustand';
import { ApiError, errorText } from './errors';
import { usePrefs } from './prefs';
import { PARTS, bySource, copyParts, markChanged, type MediaCache, type Part, type Pending, type SyncSide } from './profileSync';
import type { Session } from './session';
import { session, useApp } from './store';

const PENDING_KEY = 'am-sync-pending';
const MEDIA_KEY = 'am-sync-media';
/** Wait before trying again after a failure that may go away (network, server busy). */
const RETRY_MS = 2 * 60_000;

function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full / blocked */
  }
}

interface SyncState {
  pending: Pending;
  running: boolean;
  /** Time of the last successful copy. */
  last: number | null;
  /** Last error per target server (cleared when a copy to it works). */
  errors: Record<string, string>;
}

export const useSync = create<SyncState>(() => ({ pending: load<Pending>(PENDING_KEY, {}), running: false, last: null, errors: {} }));

function setPending(p: Pending) {
  useSync.setState({ pending: p });
  save(PENDING_KEY, p);
}

/** Media already copied: "source|id|target" -> id on the target. Kept on this device. */
const mediaMap = load<Record<string, string>>(MEDIA_KEY, {});
const cache: MediaCache = {
  get: (s, id, d) => mediaMap[`${s}|${id}|${d}`],
  set: (s, id, d, v) => {
    mediaMap[`${s}|${id}|${d}`] = v;
    save(MEDIA_KEY, mediaMap);
  },
  drop: (d) => {
    for (const k of Object.keys(mediaMap)) if (k.endsWith(`|${d}`)) delete mediaMap[k];
    save(MEDIA_KEY, mediaMap);
  },
};

/** A logged-in, connected server as the sync engine sees it. */
function side(s: Session): SyncSide {
  const me = () => s.view.me!;
  return {
    id: s.record.id,
    me: () => s.view.me,
    presence: () => {
      const p = s.view.presence[me().id] ?? {};
      return { invisible: !!p.invisible, activity: p.activity };
    },
    getBoard: async () => (await s.getProfile(me().id)).layout,
    saveBoard: async (l) => void (await s.saveProfile(me().id, l, true)),
    setProfile: (p) => s.updateProfile({ displayName: p.displayName, bio: p.bio, avatarMediaId: p.avatarMediaId ? BigInt(p.avatarMediaId) : undefined }, true),
    setPresence: (invisible, activity) => s.setPresence(invisible, activity, true),
    mediaBytes: (path) => s.t.mediaBytes(path),
    upload: async (blob, name) => (await s.upload(new File([blob], name, { type: blob.type }))).id.toString(),
  };
}

const ready = (s: Session | undefined): s is Session => !!s && s.view.status === 'online' && !!s.view.me;

/** Errors that will not go away by trying again: give up on that part. */
function permanent(e: unknown) {
  return e instanceof ApiError && !/^http_5|^rate_limited$|^internal_error$|^layout_conflict$|^unauthorized$/.test(e.code);
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, ms);
}

/** Records a change of my profile made on `serverId`. */
export function changed(serverId: string, parts: Part[]) {
  if (!usePrefs.getState().profileSync) return;
  const targets = useApp.getState().servers.map((s) => s.id);
  if (targets.length < 2) return;
  setPending(markChanged(useSync.getState().pending, serverId, parts, targets));
  schedule(usePrefs.getState().syncDelay * 1000);
}

/** Copies everything waiting to servers that are online now. */
export async function flush(): Promise<void> {
  if (useSync.getState().running) {
    schedule(5_000);
    return;
  }
  const known = new Set(useApp.getState().servers.map((s) => s.id));
  // Forget work for servers removed from this device.
  const cleaned = Object.fromEntries(Object.entries(useSync.getState().pending)
    .filter(([t]) => known.has(t))
    .map(([t, e]) => [t, Object.fromEntries(Object.entries(e).filter(([, v]) => v && known.has(v.from)))]));
  setPending(cleaned);
  if (!usePrefs.getState().profileSync) return;

  useSync.setState({ running: true });
  let retry = false;
  try {
    for (const [target, entry] of Object.entries(cleaned)) {
      const dst = session(target);
      if (!ready(dst)) continue;
      for (const [from, parts] of Object.entries(bySource(entry))) {
        const src = session(from);
        if (!ready(src)) continue;
        const stamp = Object.fromEntries(parts.map((p) => [p, entry[p]!.at]));
        let done = true;
        try {
          await copyParts(side(src), side(dst), parts, cache);
          useSync.setState((st) => {
            const errors = { ...st.errors };
            delete errors[target];
            return { last: Date.now(), errors };
          });
        } catch (e) {
          useSync.setState((st) => ({ errors: { ...st.errors, [target]: errorText(e) } }));
          if (!permanent(e)) {
            done = false;
            retry = true;
          }
        }
        if (done) {
          // Keep parts that changed again while copying.
          const now = { ...useSync.getState().pending };
          const left = { ...now[target] };
          for (const p of parts) if (left[p]?.at === stamp[p]) delete left[p];
          if (Object.keys(left).length) now[target] = left;
          else delete now[target];
          setPending(now);
        }
      }
    }
  } finally {
    useSync.setState({ running: false });
  }
  if (retry && !timer) schedule(RETRY_MS);
}

/**
 * Forgets what was copied to or from a server (it was reinstalled: its
 * media ids now mean other files).
 */
export function forgetServer(id: string) {
  for (const k of Object.keys(mediaMap)) if (k.startsWith(`${id}|`) || k.endsWith(`|${id}`)) delete mediaMap[k];
  save(MEDIA_KEY, mediaMap);
}

/** Copies all of my profile from one server to another now (joining a new server). */
export async function copyAll(from: string, to: string) {
  const src = session(from);
  const dst = session(to);
  if (!ready(src) || !ready(dst)) throw new Error('服务器还没连上');
  await copyParts(side(src), side(dst), PARTS, cache);
}

/** Waits until a server is connected and knows who I am. */
export function whenReady(id: string, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ready(session(id))) return resolve();
    const stop = useApp.subscribe(() => {
      if (ready(session(id))) {
        stop();
        clearTimeout(t);
        resolve();
      }
    });
    const t = setTimeout(() => {
      stop();
      reject(new Error('服务器还没连上'));
    }, ms);
  });
}

/** Hooks the sync onto every server session (call once at start). */
export function startSync() {
  const online = new Set<string>();
  const check = () => {
    let cameOnline = false;
    for (const rec of useApp.getState().servers) {
      const s = session(rec.id);
      if (!s) continue;
      if (!s.onOwnChange) s.onOwnChange = (parts) => changed(rec.id, parts);
      const r = ready(s);
      if (r && !online.has(rec.id)) cameOnline = true;
      if (r) online.add(rec.id);
      else online.delete(rec.id);
    }
    // A server came (back) online: copy what waited for it.
    if (cameOnline && Object.keys(useSync.getState().pending).length && !timer) schedule(3_000);
  };
  useApp.subscribe(check);
  check();
}

/** The server to copy my profile from when joining another: the one on screen, else any connected one. */
export function profileSource(): Session | undefined {
  const cur = session();
  if (ready(cur)) return cur;
  for (const rec of useApp.getState().servers) {
    const s = session(rec.id);
    if (ready(s)) return s;
  }
  return undefined;
}

/** "立即同步": copies everything of my profile from this server to all the others now. */
export async function syncNow(from: string) {
  const targets = useApp.getState().servers.map((s) => s.id);
  setPending(markChanged(useSync.getState().pending, from, PARTS, targets));
  if (timer) clearTimeout(timer);
  timer = null;
  await flush();
}
