// Several devices of mine (docs/design.md §7, 多设备).
//
// Pairing: the old device makes a one-time ticket on every server it is
// logged in on, packs them with my server list, saved login and settings
// into a bundle encrypted with a fresh key, and leaves the bundle with the
// ticket of the server on screen. The pairing code (lib/paircode.ts) holds
// that server, its ticket and the key; the new device redeems it and logs
// in everywhere.
//
// My server list: kept encrypted (vault key, shared by my devices through
// pairing, kept in the system credential store) on every server I am on, so
// a server joined on one device is offered on the others, and one I left is
// forgotten there too (lib/deviceState.ts).
import { create } from 'zustand';
import { ApiError, errorText } from './errors';
import { rememberLogin, savedPassword, useIdentity } from './identity';
import { concat, sha256 } from './joincode';
import { encodePairCode, hex, newKey, pairUrl, parsePairCode, seal, unhex, unseal } from './paircode';
import { usePrefs } from './prefs';
import { loadProviders, onProvidersChanged, saveProviders, type SyncedProviders } from './ai/keys';
import { emptyState, merge, noteLocal, plan, prune, sameState, serverKey, type DeviceState, type ServerEntry } from './deviceState';
import type { Session } from './session';
import { addServer, moveServer, removeServer, session, switchServer, useApp } from './store';
import { useTheme } from './theme';
import { endpointFromJoin, secretGet, secretSet, type Endpoint } from './transport';

/** Largest bundle the server keeps with a ticket (and largest state). */
const MAX_BUNDLE = 32 << 10;
const VAULT = 'vault-key';
const STATE_KEY = 'am-devices';

// ---------- pairing ----------

interface Bundle {
  v: 1;
  servers: { endpoint: Endpoint; name: string; ticket?: string }[];
  login?: { username: string; password?: string };
  vault?: string;
  theme?: Record<string, unknown>;
  prefs?: Record<string, unknown>;
}

export interface PairingCode {
  code: string;
  url: string;
  expiresAt: number;
  /** Servers the new device will have to log in to with the password (name: why). */
  skipped: string[];
  /** The background image was too big to take along. */
  noBackground: boolean;
}

const ready = (s: Session | undefined): s is Session => !!s && s.view.status === 'online' && !!s.view.me;

/** Plain data of a zustand store (no functions). */
function data(o: object) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'function'));
}

/** Makes a pairing code on the server `homeId` (the one on screen). */
export async function createPairing(homeId: string): Promise<PairingCode> {
  const home = session(homeId);
  if (!ready(home)) throw new Error('这个服务器还没连上');
  const { list, max } = await home.sessions();
  if (max > 0 && list.length >= max) throw new ApiError('too_many_devices');

  const skipped: string[] = [];
  const servers: Bundle['servers'] = [];
  for (const rec of useApp.getState().servers) {
    if (rec.id === homeId) {
      servers.push({ endpoint: rec.endpoint, name: rec.name });
      continue;
    }
    if (!rec.token) continue;
    const s = session(rec.id);
    let ticket: string | undefined;
    if (ready(s)) {
      try {
        ticket = (await s.createPairTicket()).ticket;
      } catch (e) {
        skipped.push(`${rec.name}：${errorText(e)}`);
      }
    } else {
      skipped.push(`${rec.name}：现在连不上`);
    }
    servers.push({ endpoint: rec.endpoint, name: rec.name, ticket });
  }
  const id = useIdentity.getState();
  const bundle: Bundle = {
    v: 1,
    servers,
    login: id.username ? { username: id.username, password: (await savedPassword()) ?? undefined } : undefined,
    vault: hex(await vaultKey(true) ?? new Uint8Array()) || undefined,
    theme: data(useTheme.getState()),
    prefs: data(usePrefs.getState()),
  };
  const key = newKey();
  let sealed = await seal(bundle, key);
  let noBackground = false;
  if (sealed.length > MAX_BUNDLE) {
    noBackground = true;
    sealed = await seal({ ...bundle, theme: { ...bundle.theme, background: '' } }, key);
  }
  const t = await home.createPairTicket(sealed);
  const join = { address: home.record.endpoint.address, plain: home.record.endpoint.plain, pin: home.record.endpoint.pin ? unhex(home.record.endpoint.pin) : undefined };
  const code = await encodePairCode({ server: join, ticket: t.ticket, key });
  return { code, url: pairUrl(home.view.downloadUrl, code), expiresAt: t.expiresAt, skipped, noBackground };
}

/**
 * Logs this device in with a pairing code from my other device: every
 * server from the bundle, the saved login and the settings. Returns the
 * servers that still need the password.
 */
export async function redeemPairing(input: string): Promise<string[]> {
  pairing = true; // no list syncing until the shared key from the bundle is in
  try {
    return await redeem(input);
  } finally {
    pairing = false;
    pushAll();
  }
}

async function redeem(input: string): Promise<string[]> {
  const p = await parsePairCode(input);
  const ep = endpointFromJoin(p.server);
  const home = addServer({ endpoint: ep, name: p.server.address });
  if (home.record.token) await home.logout(); // a fresh device place for this login
  let bundle: Bundle;
  try {
    bundle = await unseal<Bundle>(await home.redeemPair(p.ticket), p.key);
  } catch (e) {
    if (!home.record.token) removeServer(home.record.id);
    if (e instanceof ApiError) throw e;
    throw new Error('登录码里的资料打不开（可能抄错了），请重新生成一个');
  }
  if (bundle.login?.password) await rememberLogin(bundle.login.username, bundle.login.password, true);
  if (bundle.vault) {
    memoryVault = unhex(bundle.vault);
    await secretSet(VAULT, bundle.vault).catch(() => {});
  }
  if (bundle.theme) useTheme.getState().set(bundle.theme);
  if (bundle.prefs) usePrefs.setState(bundle.prefs);

  const later: string[] = [];
  for (const sv of bundle.servers) {
    if (serverKey(sv.endpoint) === serverKey(ep)) {
      useApp.setState((st) => ({ servers: st.servers.map((r) => (r.id === home.record.id ? { ...r, name: sv.name } : r)) }));
      continue;
    }
    const s = addServer({ endpoint: sv.endpoint, name: sv.name });
    if (s.record.token) continue;
    try {
      if (!sv.ticket) throw new Error('no ticket');
      await s.redeemPair(sv.ticket);
    } catch {
      try {
        if (!bundle.login?.password) throw new Error('no password');
        await s.login(bundle.login.username, bundle.login.password);
      } catch {
        later.push(sv.name);
      }
    }
  }
  switchServer(home.record.id);
  return later;
}

// ---------- my server list ----------

let memoryVault: Uint8Array | null = null;
let pairing = false;

/** The key my devices share; create: make one when there is none yet. */
async function vaultKey(create = false): Promise<Uint8Array | null> {
  if (memoryVault) return memoryVault;
  const h = await secretGet(VAULT).catch(() => null);
  if (h) return (memoryVault = unhex(h));
  if (!create) return null;
  const k = newKey();
  try {
    await secretSet(VAULT, hex(k));
  } catch {
    return null; // no credential store here: no shared list on this device
  }
  return (memoryVault = k);
}

const keyId = async (k: Uint8Array) => (await sha256(k)).slice(0, 4);

interface Local {
  state: DeviceState;
  /** Servers joined elsewhere I chose not to join here. */
  ignored: string[];
  /** Offers to show (servers joined on another device). */
  offers: ServerEntry[];
}

function loadLocal(): Local {
  try {
    const v = JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null') as Partial<Local> | null;
    // Version 1 knew servers by address: start over (this device's servers are noted again at start).
    return { state: v?.state?.v === 2 ? v.state : emptyState(), ignored: v?.state?.v === 2 ? v.ignored ?? [] : [], offers: [] };
  } catch {
    return { state: emptyState(), ignored: [], offers: [] };
  }
}

export const useDevices = create<Local>(loadLocal);

function saveLocal(patch: Partial<Local>) {
  // Provider keys never go into localStorage (they live in the credential store).
  if (patch.state?.providers) patch = { ...patch, state: { v: 2, servers: patch.state.servers } };
  useDevices.setState(patch);
  const { state, ignored } = useDevices.getState();
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({ state, ignored }));
  } catch {
    /* storage blocked */
  }
}

/** Applies a merged list here: forget servers left elsewhere, offer new ones. */
function apply(state: DeviceState) {
  const recs = useApp.getState().servers;
  const { remove, offers } = plan(state, recs.map((r) => r.endpoint), useDevices.getState().ignored);
  saveLocal({ state, offers });
  // Moved to another address on another device: check it here too.
  for (const r of recs) {
    const e = state.servers[serverKey(r.endpoint)];
    if (r.token && e && !e.removed && e.endpoint.address !== r.endpoint.address) void moveServer(r.id, e.endpoint.address);
  }
  for (const ep of remove) {
    const r = recs.find((x) => serverKey(x.endpoint) === serverKey(ep));
    // Only when it was removed after it was added here (record ids are "s" +
    // creation time): joining again on this device is not undone.
    if (r && state.servers[serverKey(ep)].at > parseInt(r.id.slice(1), 36)) removeServer(r.id);
  }
}

/** Pulls my list from one server, merges, and saves it back when it changed. */
async function syncWith(s: Session) {
  if (pairing) return;
  const key = await vaultKey(true);
  if (!key) return;
  const kid = await keyId(key);
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await s.clientState();
    let theirs = emptyState();
    if (remote.data.length) {
      // Written with another key (a device never paired with this one): leave it alone.
      if (remote.data.slice(0, 4).some((b, i) => b !== kid[i])) return;
      try {
        theirs = await unseal<DeviceState>(remote.data.slice(4), key);
      } catch {
        return;
      }
      if (theirs.v !== 2) theirs = emptyState(); // older format: replaced by ours
    }
    const providers = await loadProviders();
    const mine: DeviceState = providers.at ? { ...useDevices.getState().state, providers } : useDevices.getState().state;
    const merged = prune(merge(mine, theirs), Date.now());
    if (merged.providers && merged.providers.at > providers.at) await saveProviders(merged.providers as SyncedProviders, true);
    apply(merged);
    if (sameState(merged, theirs)) return;
    try {
      await s.putClientState(concat(kid, await seal(merged, key)), remote.updatedAt);
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'state_conflict')) throw e;
    }
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
function pushAll() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    for (const r of useApp.getState().servers) {
      const s = session(r.id);
      if (ready(s)) syncWith(s).catch(() => {});
    }
  }, 2_000);
}

/** Joins a server that was joined on my other device, with the saved login. */
export async function acceptOffer(e: ServerEntry) {
  const s = addServer({ endpoint: e.endpoint, name: e.name });
  saveLocal({ offers: useDevices.getState().offers.filter((o) => serverKey(o.endpoint) !== serverKey(e.endpoint)) });
  const id = useIdentity.getState();
  const pw = await savedPassword();
  if (!s.record.token && id.username && pw) await s.login(id.username, pw).catch(() => {});
  switchServer(s.record.id); // not logged in: the login screen asks for the password
}

export function ignoreOffer(e: ServerEntry) {
  const k = serverKey(e.endpoint);
  saveLocal({ ignored: [...useDevices.getState().ignored, k], offers: useDevices.getState().offers.filter((o) => serverKey(o.endpoint) !== k) });
}

/** Watches my servers: notes joins / leaves and syncs the list (call once at start). */
export function startDevices() {
  onProvidersChanged(pushAll);
  const keys = (list = useApp.getState().servers) => new Map(list.filter((r) => r.token).map((r) => [serverKey(r.endpoint), r]));
  let known = keys();
  // Servers logged in before this feature existed.
  const st = noteLocal(useDevices.getState().state, [...known.values()], [], Date.now());
  if (!sameState(st, useDevices.getState().state)) saveLocal({ state: st });
  const online = new Set<string>();
  const watch = (app: ReturnType<typeof useApp.getState>, prev?: ReturnType<typeof useApp.getState>) => {
    if (prev && app.servers !== prev.servers) {
      const now = keys(app.servers);
      const all = new Set(app.servers.map((r) => serverKey(r.endpoint)));
      // New here, or the same server at a new address.
      const added = [...now].filter(([k, r]) => known.get(k)?.endpoint.address !== r.endpoint.address).map(([, r]) => r);
      // Gone from this device entirely (left / forgotten), not just logged out.
      const removed = [...known].filter(([k]) => !all.has(k)).map(([, r]) => r.endpoint);
      known = now;
      if (added.length || removed.length) {
        saveLocal({ state: noteLocal(useDevices.getState().state, added, removed, Date.now()) });
        apply(useDevices.getState().state);
        pushAll();
      }
    }
    for (const r of app.servers) {
      const s = session(r.id);
      if (s && !s.onClientState) s.onClientState = () => void syncWith(s).catch(() => {});
      const on = ready(s);
      if (on && !online.has(r.id)) syncWith(s).catch(() => {});
      if (on) online.add(r.id);
      else online.delete(r.id);
    }
  };
  useApp.subscribe(watch);
  watch(useApp.getState());
}
