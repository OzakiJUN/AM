// The list of my servers, shared by my devices (docs/design.md §7, 多设备).
// Each server is an entry with the time of its last change; removed ones
// stay as tombstones so a removal travels too. Merging takes the newer entry
// per server. Pure (no I/O): lib/devices.ts stores it, encrypted, on every
// server I am logged in on.
import type { Endpoint } from './transport';

export interface ServerEntry {
  endpoint: Endpoint;
  name: string;
  /** Time of the last change (added / removed). */
  at: number;
  removed?: boolean;
}

export interface DeviceState {
  v: 2;
  servers: Record<string, ServerEntry>;
  /** My AI model providers with keys (lib/ai/keys.ts); never stored in plain local storage. */
  providers?: { at: number; list: unknown[] };
}

export const emptyState = (): DeviceState => ({ v: 2, servers: {} });

/**
 * One server = its certificate pin (a reinstalled server is another one; a
 * server that moved to a new relay address is the same). Servers without a
 * pin (real certificates, local testing) are known by address.
 */
export const serverKey = (ep: Endpoint) => (ep.pin ? `pin:${ep.pin}` : `${ep.address}|${ep.plain ? 1 : 0}`);

/** Newer entry per server wins; on a tie a removal wins. */
export function merge(a: DeviceState, b: DeviceState): DeviceState {
  const servers: Record<string, ServerEntry> = { ...a.servers };
  for (const [k, e] of Object.entries(b.servers)) {
    const mine = servers[k];
    if (!mine || e.at > mine.at || (e.at === mine.at && e.removed && !mine.removed)) servers[k] = e;
  }
  const providers = (b.providers?.at ?? 0) > (a.providers?.at ?? 0) ? b.providers : a.providers;
  return providers ? { v: 2, servers, providers } : { v: 2, servers };
}

export function sameState(a: DeviceState, b: DeviceState) {
  if ((a.providers?.at ?? 0) !== (b.providers?.at ?? 0)) return false;
  const ka = Object.keys(a.servers);
  if (ka.length !== Object.keys(b.servers).length) return false;
  return ka.every((k) => {
    const x = a.servers[k];
    const y = b.servers[k];
    return !!y && x.at === y.at && !!x.removed === !!y.removed && x.name === y.name;
  });
}

/** Records servers I got into (added) or left / forgot (removed) on this device. */
export function noteLocal(s: DeviceState, added: { endpoint: Endpoint; name: string }[], removed: Endpoint[], now: number): DeviceState {
  const servers = { ...s.servers };
  const keep = s.providers ? { providers: s.providers } : {};
  for (const r of added) {
    const k = serverKey(r.endpoint);
    // New, joined again, or moved to another address.
    if (!servers[k] || servers[k].removed || servers[k].endpoint.address !== r.endpoint.address) servers[k] = { endpoint: r.endpoint, name: r.name, at: now };
  }
  for (const ep of removed) {
    const k = serverKey(ep);
    if (servers[k] && !servers[k].removed) servers[k] = { ...servers[k], removed: true, at: now };
  }
  return { v: 2, servers, ...keep };
}

/**
 * What the merged list means for this device: servers to forget here
 * (removed on another device) and servers joined elsewhere to offer.
 */
export function plan(s: DeviceState, local: Endpoint[], ignored: string[]) {
  const here = new Set(local.map(serverKey));
  const remove = local.filter((ep) => s.servers[serverKey(ep)]?.removed);
  const offers = Object.entries(s.servers)
    .filter(([k, e]) => !e.removed && !here.has(k) && !ignored.includes(k))
    .map(([, e]) => e);
  return { remove, offers };
}

/** Drops tombstones older than maxAge (they have reached every device by then). */
export function prune(s: DeviceState, now: number, maxAge = 180 * 86_400_000): DeviceState {
  return { ...s, servers: Object.fromEntries(Object.entries(s.servers).filter(([, e]) => !e.removed || now - e.at < maxAge)) };
}
