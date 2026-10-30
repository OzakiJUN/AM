// App state: the list of servers (kept on this device), one Session per
// server, and UI state. Components read from here; actions go to sessions.
import { create } from 'zustand';
import { Session, previewText, type ServerRecord, type SessionView } from './session';
import { notify } from './platform';
import type { Conversation, User } from './types';

/**
 * 'account' = 账号设置 (profile editing, invites, devices); 'profile' = my
 * profile page; 'server' = the current server's profile page.
 */
export type Page = 'channels' | 'dms' | 'ai' | 'account' | 'profile' | 'server' | 'settings';
/** Pages that list conversations: channels, direct messages, AI chats. */
export type ConvPage = 'channels' | 'dms' | 'ai';

const STORE_KEY = 'am-servers';
const CURRENT_KEY = 'am-current-server';

function loadRecords(): ServerRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as ServerRecord[];
  } catch {
    return [];
  }
}
function saveRecords(list: ServerRecord[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* storage full / blocked */
  }
}

interface AppState {
  /** 'welcome' shows the join screen (also used for "添加服务器"). */
  view: 'welcome' | 'main';
  page: Page;
  servers: ServerRecord[];
  currentId: string | null;
  sessions: Record<string, SessionView>;
  /** Open conversation per page and server, keyed by openKey(). */
  openConvs: Record<string, string | null>;
  /** Whose profile the 'profile' page shows (null = mine). */
  profileUser: string | null;
  set: (patch: Partial<AppState>) => void;
}

export const useApp = create<AppState>((set) => ({
  view: 'welcome',
  page: 'channels',
  servers: [],
  currentId: null,
  sessions: {},
  openConvs: {},
  profileUser: null,
  set: (patch) => set(patch),
}));

const live = new Map<string, Session>();

export function session(id?: string | null): Session | undefined {
  return live.get(id ?? useApp.getState().currentId ?? '');
}

/** The Session of the server on screen (throws if none: only call from screens that need one). */
export function current(): Session {
  const s = session();
  if (!s) throw new Error('no server');
  return s;
}

function attach(rec: ServerRecord): Session {
  const s = new Session(
    rec,
    (v) => useApp.setState((st) => ({ sessions: { ...st.sessions, [rec.id]: v } })),
    (r) => {
      const list = useApp.getState().servers.map((x) => (x.id === r.id ? r : x));
      useApp.setState({ servers: list });
      saveRecords(list);
    },
    (convId, m) => {
      const st = useApp.getState();
      const open = st.openConvs[openKey(st.page as ConvPage, rec.id)];
      const focused = document.hasFocus() && st.currentId === rec.id && open === convId;
      if (focused) return;
      const v = s.view;
      const conv = v.convs[convId];
      const who = s.nameOf(m.senderId);
      notify(conv?.kind === 'group' ? conv.name : who, (conv?.kind === 'group' ? `${who}：` : '') + previewText(m, s.nameOf));
    },
  );
  live.set(rec.id, s);
  useApp.setState((st) => ({ sessions: { ...st.sessions, [rec.id]: s.view } }));
  return s;
}

/** Loads saved servers and connects to them. */
export function boot() {
  const servers = loadRecords();
  let currentId = localStorage.getItem(CURRENT_KEY);
  if (!servers.some((s) => s.id === currentId)) currentId = servers[0]?.id ?? null;
  useApp.setState({ servers, currentId, view: servers.some((s) => s.token) ? 'main' : 'welcome' });
  for (const rec of servers) attach(rec).start();
}

/**
 * Adds a server (from a join code) or returns the existing one with the same
 * address. Same address but a different certificate means the server was
 * reinstalled: the saved record takes the new certificate and drops the old
 * login (it is gone with the old database).
 */
export function addServer(rec: Omit<ServerRecord, 'id'>): Session {
  const servers = useApp.getState().servers;
  const existing = servers.find((s) => s.endpoint.address === rec.endpoint.address);
  if (existing) {
    const same = existing.endpoint.pin === rec.endpoint.pin && existing.endpoint.plain === rec.endpoint.plain;
    if (same) return live.get(existing.id)!;
    live.get(existing.id)?.stop();
    live.delete(existing.id);
    const fresh: ServerRecord = { ...existing, endpoint: rec.endpoint, name: rec.name, token: undefined, userId: undefined };
    const list = servers.map((x) => (x.id === existing.id ? fresh : x));
    useApp.setState({ servers: list });
    saveRecords(list);
    return attach(fresh);
  }
  const full: ServerRecord = { ...rec, id: 's' + Date.now().toString(36) };
  const list = [...useApp.getState().servers, full];
  useApp.setState({ servers: list });
  saveRecords(list);
  return attach(full);
}

export function switchServer(id: string) {
  useApp.setState({ currentId: id, view: 'main' });
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Leaves the server for good (see Session.leaveServer) and forgets it here. */
export async function leaveServer(id: string) {
  await live.get(id)?.leaveServer();
  // Leaving the last server goes to the join screen: keep `page` as it is,
  // since changing it in the same render would mount new animated parts
  // inside the screen that is fading out, and that fade never finishes.
  const last = useApp.getState().servers.length === 1;
  removeServer(id);
  if (!last && useApp.getState().page === 'server') useApp.setState({ page: 'channels' });
}

/** Forgets a server on this device (logs out first). */
export function removeServer(id: string) {
  const s = live.get(id);
  s?.stop();
  live.delete(id);
  const list = useApp.getState().servers.filter((x) => x.id !== id);
  saveRecords(list);
  const sessions = { ...useApp.getState().sessions };
  delete sessions[id];
  const currentId = useApp.getState().currentId === id ? list[0]?.id ?? null : useApp.getState().currentId;
  useApp.setState({ servers: list, sessions, currentId, view: list.length ? useApp.getState().view : 'welcome' });
}

export const openKey = (page: ConvPage, serverId: string) => `${page}:${serverId}`;

/** DMs with bot / AI accounts live on the AI page, not with the other DMs. */
export function isBotConv(c: Conversation, users: Record<string, User>) {
  if (c.kind !== 'dm' || !c.peerId) return false;
  const t = users[c.peerId]?.type;
  return t === 'bot' || t === 'ai';
}

/** Which page lists a conversation: channels, DMs, or the AI page. */
export function convPage(c: Conversation, users: Record<string, User>): ConvPage {
  if (c.kind === 'group') return 'channels';
  return isBotConv(c, users) ? 'ai' : 'dms';
}

/** The conversation open on a page of a server. */
export function useOpenConv(page: ConvPage, serverId: string) {
  return useApp((st) => st.openConvs[openKey(page, serverId)] ?? null);
}

/** Opens a conversation on the page it belongs to and switches to that page. */
export function openConv(convId: string) {
  const st = useApp.getState();
  const id = st.currentId;
  // The live session view: the store's copy can lag right after a change
  // (e.g. a channel created a moment ago).
  const v = id ? live.get(id)?.view : undefined;
  const c = v?.convs[convId];
  if (!id || !v || !c) return;
  const page = convPage(c, v.users);
  useApp.setState({ openConvs: { ...st.openConvs, [openKey(page, id)]: convId }, page });
}

/** Shows someone's profile page (null / my id = mine). */
export function openProfile(userId: string | null) {
  const me = session()?.view.me?.id;
  useApp.setState({ page: 'profile', profileUser: userId === me ? null : userId });
}

/** Presence of a user on the server on screen (undefined = offline). */
export function usePresence(userId?: string) {
  return useApp((st) => (st.currentId && userId ? st.sessions[st.currentId]?.presence[userId] : undefined));
}

/** View of the server on screen. */
export function useCurrent(): SessionView | undefined {
  return useApp((st) => (st.currentId ? st.sessions[st.currentId] : undefined));
}
