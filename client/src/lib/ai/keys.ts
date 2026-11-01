// The model providers I have keys for (docs/design.md §9). The list (name,
// kind, address) is in localStorage; each key is in the system credential
// store (Windows Credential Manager, one entry per key: entries are small).
// lib/devices.ts carries the whole list, keys included, to my other devices
// inside the end-to-end encrypted device state; servers never see keys.
import { create } from 'zustand';
import { secretDelete, secretGet, secretSet } from '../transport';
import type { Provider } from './providers';

const LIST_KEY = 'am-ai-providers';
const secretName = (id: string) => `ai-key:${id}`;

/** A provider list with the time of its last change (newest wins between devices). */
export interface SyncedProviders {
  at: number;
  list: Provider[];
}

interface State extends SyncedProviders {
  loaded: boolean;
}

export const useProviders = create<State>(() => ({ at: 0, list: [], loaded: false }));

const listeners: (() => void)[] = [];
/** Called after I change the list here (lib/devices.ts syncs it). */
export function onProvidersChanged(fn: () => void) {
  listeners.push(fn);
}

function readList(): { at: number; list: Omit<Provider, 'key'>[] } {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) ?? 'null') ?? { at: 0, list: [] };
  } catch {
    return { at: 0, list: [] };
  }
}

/** The list with keys (from the credential store). */
export async function loadProviders(): Promise<SyncedProviders> {
  const { at, list } = readList();
  const full = await Promise.all(list.map(async (p) => ({ ...p, key: (await secretGet(secretName(p.id)).catch(() => null)) ?? '' })));
  useProviders.setState({ at, list: full, loaded: true });
  return { at, list: full };
}

/** Replaces the list (keys into the credential store). quiet: it came from another device. */
export async function saveProviders(s: SyncedProviders, quiet = false) {
  const old = readList().list;
  for (const p of s.list) if (p.key) await secretSet(secretName(p.id), p.key);
  for (const p of old) if (!s.list.some((x) => x.id === p.id)) await secretDelete(secretName(p.id)).catch(() => {});
  try {
    localStorage.setItem(LIST_KEY, JSON.stringify({ at: s.at, list: s.list.map(({ key: _key, ...rest }) => rest) }));
  } catch {
    /* storage blocked */
  }
  useProviders.setState({ at: s.at, list: s.list, loaded: true });
  if (!quiet) listeners.forEach((f) => f());
}

export async function putProvider(p: Provider) {
  const { list } = useProviders.getState();
  const next = list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
  await saveProviders({ at: Date.now(), list: next });
}

export async function removeProvider(id: string) {
  await saveProviders({ at: Date.now(), list: useProviders.getState().list.filter((x) => x.id !== id) });
}

export const newProviderId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
