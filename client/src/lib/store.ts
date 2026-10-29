// App state: the list of servers (kept on this device), one Session per
// server, and UI state. Components read from here; actions go to sessions.
import { create } from 'zustand';
import { Session, previewText, type ServerRecord, type SessionView } from './session';
import { notify } from './platform';
import type { Conversation, User } from './types';

export type Page = 'chats' | 'contacts' | 'ai' | 'me' | 'settings';

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
  /** Open conversation per server (消息 page). */
  convId: Record<string, string | null>;
  /** Open bot / AI conversation per server (AI page). */
  aiConvId: Record<string, string | null>;
  showMembers: boolean;
  set: (patch: Partial<AppState>) => void;
}

export const useApp = create<AppState>((set) => ({
  view: 'welcome',
  page: 'chats',
  servers: [],
  currentId: null,
  sessions: {},
  convId: {},
  aiConvId: {},
  showMembers: true,
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
      const open = st.page === 'chats' ? st.convId[rec.id] : st.page === 'ai' ? st.aiConvId[rec.id] : null;
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

/** Adds a server (from a join code) or returns the existing one with the same address. */
export function addServer(rec: Omit<ServerRecord, 'id'>): Session {
  const existing = useApp.getState().servers.find((s) => s.endpoint.address === rec.endpoint.address);
  if (existing) {
    const s = live.get(existing.id)!;
    return s;
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

/** DMs with bot / AI accounts live on the AI page, not in the message list. */
export function isBotConv(c: Conversation, users: Record<string, User>) {
  if (c.kind !== 'dm' || !c.peerId) return false;
  const t = users[c.peerId]?.type;
  return t === 'bot' || t === 'ai';
}

/** Opens a conversation on the page it belongs to (AI page for bot / AI DMs). */
export function openConv(convId: string | null) {
  const st = useApp.getState();
  const id = st.currentId;
  if (!id) return;
  const v = st.sessions[id];
  const c = convId && v ? v.convs[convId] : undefined;
  if (c && v && isBotConv(c, v.users)) useApp.setState({ aiConvId: { ...st.aiConvId, [id]: convId }, page: 'ai' });
  else useApp.setState({ convId: { ...st.convId, [id]: convId }, page: 'chats' });
}

/** View of the server on screen. */
export function useCurrent(): SessionView | undefined {
  return useApp((st) => (st.currentId ? st.sessions[st.currentId] : undefined));
}
