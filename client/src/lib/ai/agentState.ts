// What the AIs running on this device are doing on the computer: the
// "正在操作" bar, the owner's permission questions, the action log and the
// stop switch (button, or F12 while an AI is operating; docs/design.md §9).
import { create } from 'zustand';
import { inTauri } from '../platform';
import type { ToolCategory } from './persona';

export interface Activity {
  aiName: string;
  /** What it is doing right now, in words. */
  action: string;
  step: number;
}

export type Answer = 'once' | 'always' | 'deny';

export interface Ask {
  id: number;
  aiName: string;
  speaker: string;
  action: string;
  category: ToolCategory;
  resolve: (a: Answer) => void;
}

interface AgentState {
  /** Running agents, by `${serverId}|${aiId}`. */
  active: Record<string, Activity>;
  asks: Ask[];
}

export const useAgent = create<AgentState>(() => ({ active: {}, asks: [] }));

const stops = new Set<string>();

export function setActivity(key: string, a: Activity | null) {
  useAgent.setState((st) => {
    const active = { ...st.active };
    if (a) active[key] = a;
    else delete active[key];
    return { active };
  });
  syncStopKey();
  if (!a) stops.delete(key);
}

/** The owner pressed stop (button or F12). */
export function stopAgent(key?: string) {
  for (const k of key ? [key] : Object.keys(useAgent.getState().active)) stops.add(k);
}

export const stopped = (key: string) => stops.has(key);

let keyOn = false;
/** Hold F12 only while some AI is operating (games keep it otherwise). */
function syncStopKey() {
  const want = Object.keys(useAgent.getState().active).length > 0;
  if (want === keyOn || !inTauri) return;
  keyOn = want;
  void import('@tauri-apps/api/core').then(({ invoke }) => invoke('agent_stop_key', { on: want })).catch(() => {});
}

/** Listens for F12 (call once at start). */
export function startAgentKeys() {
  if (!inTauri) return;
  void import('@tauri-apps/api/event').then(({ listen }) => listen('agent-stop', () => stopAgent()));
}

let askId = 0;
const ASK_TIMEOUT = 120_000;

/** Asks the owner whether the AI may do something; no answer in 2 minutes = no. */
export function askOwner(q: Omit<Ask, 'id' | 'resolve'>): Promise<Answer> {
  return new Promise((resolve) => {
    const id = ++askId;
    const done = (a: Answer) => {
      clearTimeout(timer);
      useAgent.setState((st) => ({ asks: st.asks.filter((x) => x.id !== id) }));
      resolve(a);
    };
    const timer = setTimeout(() => done('deny'), ASK_TIMEOUT);
    useAgent.setState((st) => ({ asks: [...st.asks, { ...q, id, resolve: done }] }));
  });
}

// ---------- action log (this device only) ----------

export interface LogEntry {
  at: number;
  speaker: string;
  action: string;
  result: 'ok' | 'denied' | 'error' | 'stopped';
  detail?: string;
}

const LOG_MAX = 300;
const logKey = (key: string) => `am-ai-log:${key}`;

export function readLog(key: string): LogEntry[] {
  try {
    return JSON.parse(localStorage.getItem(logKey(key)) ?? '[]') as LogEntry[];
  } catch {
    return [];
  }
}

export function appendLog(key: string, e: LogEntry) {
  try {
    localStorage.setItem(logKey(key), JSON.stringify([e, ...readLog(key)].slice(0, LOG_MAX)));
  } catch {
    /* storage full / blocked */
  }
}
