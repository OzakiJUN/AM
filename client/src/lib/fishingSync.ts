// One earning save with read-only replicas. The client relays through its own
// authenticated sessions; server rows and destination-bound exports enforce moves.
import { session, useApp } from './store';
import type { Session } from './session';
import type { FishingAccount } from './fishing';
const KEY = 'am-fishing-save-v2';
interface Ref { server: string; user: string; identity: string }
interface Pending { target: string; user: string; transfer: string; source: string; sourceUser: string }
const snapshots = new Map<string, string>();
interface Saved { active?: Ref; pending?: Pending }
function load(): Saved { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } }
function save(v: Saved) { localStorage.setItem(KEY, JSON.stringify(v)); }
let tail: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => Promise<T>): Promise<T> { const next = tail.then(fn, fn); tail = next.catch(() => {}); return next; }
const human = (s: Session) => s.view?.me?.type === 'human';
const online = (s: Session | undefined): s is Session => !!s && s.view.status === 'online' && !!s.view.me;
function peers(s: Session): Session[] { return [...new Map([s, ...useApp.getState().servers.map((r) => session(r.id)).filter(online)].filter(human).map((p) => [p.record.id, p])).values()]; }
const ref = (s: Session, a: FishingAccount): Ref => ({ server: s.record.id, user: s.view.me!.id, identity: a.identity });
async function resume(state: Saved, list: Session[]) {
  if (!state.pending) return;
  const p = state.pending, dst = list.find((s) => s.record.id === p.target && s.view.me?.id === p.user);
  if (!dst) throw new Error('存档迁移尚未完成，请先连接原定的目标服务器');
  const current = await dst.fishingRawAccount();
  if (!current.frozen && current.transfer_id === p.transfer) { state.active = ref(dst, current); delete state.pending; save(state); return; }
  let payload = snapshots.get(p.transfer);
  if (!payload) {
    const src = list.find((s) => s.record.id === p.source && s.view.me?.id === p.sourceUser);
    if (!src) throw new Error('请连接迁移来源服务器，恢复未完成的存档传输');
    const account = await src.fishingRawAccount();
    payload = JSON.stringify(await src.fishingSyncRequest('export', '', account.revision, p.transfer, current.local_slot));
  }
  const snapshot = await dst.fishingSyncRequest('activate', payload, current.revision, p.transfer);
  snapshots.delete(p.transfer);
  state.active = ref(dst, snapshot.account); delete state.pending; save(state);
}
async function sourceFor(requester: Session): Promise<{ source: Session; account: FishingAccount; state: Saved; list: Session[] }> {
  const state = load(), list = peers(requester); await resume(state, list);
  const accounts = new Map<string, FishingAccount>();
  for (const s of list) accounts.set(s.record.id, await s.fishingRawAccount());
  let source = state.active ? list.find((s) => s.record.id === state.active!.server && s.view.me?.id === state.active!.user) : undefined;
  if (state.active) {
    const moved = list.find((s) => { const a = accounts.get(s.record.id)!; return a.identity === state.active!.identity && !a.frozen; });
    if (moved) source = moved;
    if (!source) throw new Error('钓鱼存档所在服务器未连接，请先连上它再同步');
  } else {
    const identity = accounts.get(requester.record.id)!.identity;
    const active = list.filter((s) => { const a = accounts.get(s.record.id)!; return a.identity === identity && !a.frozen; });
    if (active.length > 1) throw new Error('发现同一存档有多个活动副本，已暂停同步以保留数据');
    source = active[0] ?? requester;
  }
  let a = accounts.get(source.record.id)!;
  if (a.frozen) {
    const destination = list.find((s) => accounts.get(s.record.id)?.local_slot === a.transfer_to);
    if (!destination) throw new Error('钓鱼存档已移出，请连接原定目标服务器完成迁移');
    state.pending = { target: destination.record.id, user: destination.view.me!.id, transfer: a.transfer_id, source: source.record.id, sourceUser: source.view.me!.id }; save(state);
    await resume(state, list); source = destination; a = await source.fishingRawAccount();
  }
  state.active = ref(source, a); save(state);
  return { source, account: a, state, list };
}
async function replicate(source: Session, a: FishingAccount, list: Session[]) {
  const snapshot = JSON.stringify({ account: a, receipts: {} });
  for (const dst of list) {
    if (dst === source) continue;
    const current = await dst.fishingRawAccount();
    if (current.identity === a.identity && current.revision === a.revision && current.frozen) continue;
    await dst.fishingSyncRequest('mirror', snapshot, current.revision);
  }
}
export function readFishingSave(s: Session): Promise<FishingAccount> {
  if (!human(s)) return s.fishingRawAccount();
  return locked(async () => { try { const { source, account, list } = await sourceFor(s); await replicate(source, account, list); return s === source ? account : s.fishingRawAccount(); } catch { return s.fishingRawAccount(); } });
}
export function withFishingSave<T>(s: Session, act: () => Promise<T>): Promise<T> {
  if (!human(s)) return act();
  return locked(async () => {
    const { source, account: sourceAccount, state, list } = await sourceFor(s);
    if (source !== s) {
      let target = await s.fishingRawAccount(); const transfer = crypto.randomUUID();
      // Validate and prepare a read-only destination before freezing the source.
      if (target.identity !== sourceAccount.identity || !target.frozen || target.revision !== sourceAccount.revision) {
        await s.fishingSyncRequest('mirror', JSON.stringify({ account: sourceAccount, receipts: {} }), target.revision);
        target = await s.fishingRawAccount();
      }
      let exported;
      for (let tries = 0; tries < 3; tries++) {
        const current = await source.fishingRawAccount();
        try { exported = await source.fishingSyncRequest('export', '', current.revision, transfer, target.local_slot); break; }
        catch (e) { if (tries === 2) throw e; }
      }
      snapshots.set(transfer, JSON.stringify(exported));
      state.pending = { target: s.record.id, user: s.view.me!.id, transfer, source: source.record.id, sourceUser: source.view.me!.id }; save(state);
      await resume(state, list);
    }
    const result = await act();
    // A completed purchase stays completed even if another server is offline.
    const current = await s.fishingRawAccount(); state.active = ref(s, current); save(state);
    await replicate(s, current, list).catch(() => {});
    return result;
  });
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startFishingSync() {
  if (timer) return;
  timer = setInterval(() => { const s = session(); if (online(s) && human(s)) void readFishingSave(s).catch(() => {}); }, 15000);
}
