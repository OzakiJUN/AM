// Someone else's AI operating this computer (docs/design.md §9). Off unless
// I turn it on for that AI here, on this device (it is this computer's
// permission, so it is not synced). Requests come through the server
// (Session.onRemoteTool); this decides, asks me when the level says so,
// runs the tool and answers.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RemoteToolAsk, Session } from '../session';
import { argsOf, categoryOf, describeCall, levelFor, REMOTE_CATEGORIES, REMOTE_TOOLS } from './agent';
import { appendLog, askOwner, setActivity, stopped } from './agentState';
import { defaultComputer, type ComputerSettings, type Level, type ToolCategory } from './persona';
import { execTool } from './tools';

export interface RemoteAllow {
  name: string;
  levels: Partial<Record<ToolCategory, Level>>;
  workDirs: string[];
}

interface RemoteState {
  /** `${serverId}|${aiId}` -> what that AI may do here. */
  allow: Record<string, RemoteAllow>;
  set: (key: string, v: RemoteAllow | null) => void;
}

export const useRemote = create<RemoteState>()(
  persist(
    (set) => ({
      allow: {},
      set: (key, v) => set((st) => {
        const allow = { ...st.allow };
        if (v) allow[key] = v;
        else delete allow[key];
        return { allow };
      }),
    }),
    { name: 'am-remote-allow' },
  ),
);

/** Turning it on starts with "ask me" for everything; the owner raises what they want. */
export const newAllow = (name: string): RemoteAllow => ({ name, workDirs: [], levels: Object.fromEntries(REMOTE_CATEGORIES.map((c) => [c, 'ask'])) });

/** The computer settings an allowance stands for (unknown categories = no). */
export function remoteComputer(a: RemoteAllow): ComputerSettings {
  const base = defaultComputer();
  const levels = Object.fromEntries(Object.keys(base.levels).map((c) => [c, a.levels[c as ToolCategory] ?? 'deny'])) as ComputerSettings['levels'];
  return { ...base, enabled: true, workDirs: a.workDirs, levels, vision: true, mcp: [] };
}

const answer = (s: Session, ask: RemoteToolAsk, ok: boolean, text: string, images: string[] = []) =>
  s.remoteToolResult(ask, { ok, text, images }).catch(() => {});

/** One request from someone's AI (set as Session.onRemoteTool for my servers). */
export async function handleRemote(serverId: string, s: Session, ask: RemoteToolAsk) {
  const key = `${serverId}|${ask.ai.id}`;
  const allow = useRemote.getState().allow[key];
  const who = `${ask.ai.name}（${ask.ai.ownerName ?? '别人'}的 AI）`;
  if (!allow) return answer(s, ask, false, '对方没有允许你的 AI 操作他的电脑');
  if (!REMOTE_TOOLS.includes(ask.tool)) return answer(s, ask, false, `不能远程用这个工具：${ask.tool}`);
  const args = argsOf(ask.argsJson);
  const action = describeCall(ask.tool, args);
  const logKey = `remote:${key}`;
  const computer = remoteComputer(allow);
  let level = levelFor(computer, ask.tool);
  const category = categoryOf(ask.tool);
  if (level === 'ask' && category) {
    const a = await askOwner({ aiName: who, speaker: ask.ai.ownerName ?? '别人', action, category });
    if (a === 'always') useRemote.getState().set(key, { ...allow, levels: { ...allow.levels, [category]: 'allow' } });
    level = a === 'deny' ? 'deny' : 'allow';
  }
  if (level === 'deny' || stopped(logKey)) {
    appendLog(logKey, { at: Date.now(), speaker: who, action, result: 'denied' });
    return answer(s, ask, false, '对方没有允许这个操作');
  }
  setActivity(logKey, { aiName: who, action, step: 1 });
  try {
    const r = await execTool(ask.tool, args, { computer, scale: 1, mcp: new Map(), owner: logKey });
    appendLog(logKey, { at: Date.now(), speaker: who, action, result: 'ok', detail: r.text.slice(0, 300) });
    await answer(s, ask, true, r.text, r.images ?? []);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    appendLog(logKey, { at: Date.now(), speaker: who, action, result: 'error', detail: text });
    await answer(s, ask, false, `出错了：${text}`);
  } finally {
    setActivity(logKey, null);
  }
}
