// Runs my AI accounts on this device (docs/design.md §9). Each AI has one
// device that runs it (settings.runner); that device logs in as the AI
// (POST /api/v1/ai/{id}/run, token kept in the credential store), reads
// what people write to it and answers with my model key. The reply streams
// into `streams` (shown in the chat on this device) and is sent when done,
// with its mood for the portrait.
import { create } from 'zustand';
import { deviceId } from '../deviceId';
import { errorText } from '../errors';
import { splitMoodTag } from '../portraits';
import { Session, deviceName, type AIInfo, type ServerRecord } from '../session';
import { session, useApp } from '../store';
import { aiRequest, secretDelete, secretGet, secretSet } from '../transport';
import type { Message } from '../types';
import { loadProviders, useProviders } from './keys';
import { argsOf, categoryOf, computerPrompt, describeCall, levelFor, toolsFor } from './agent';
import { appendLog, askOwner, setActivity, stopped } from './agentState';
import { parseSettings, previewText, systemPrompt, toChat, type AISettings } from './persona';
import { buildRequest, errorOf, streamReader, type AgentMsg, type ToolCall } from './providers';
import { execTool, loadMcpTools, stopMcp, type ToolCtx } from './tools';

interface AIState {
  /** My AI accounts per server (owner view, with settings). */
  byServer: Record<string, AIInfo[]>;
  /** Reply being written: `${serverId}|${convId}` -> text so far. */
  streams: Record<string, string>;
  /** Last error per AI (`${serverId}|${aiId}`), shown in its chat and settings. */
  errors: Record<string, string>;
  /** AIs running on this device (`${serverId}|${aiId}`) and whether they are connected. */
  running: Record<string, boolean>;
}

export const useAI = create<AIState>(() => ({ byServer: {}, streams: {}, errors: {}, running: {} }));

const k = (a: string, b: string) => `${a}|${b}`;
const tokenName = (serverId: string, aiId: string) => `ai-token:${serverId}:${aiId}`;

function patch<K extends 'streams' | 'errors' | 'running'>(field: K, key: string, value: AIState[K][string] | undefined) {
  useAI.setState((st) => {
    const next = { ...st[field] } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = value;
    return { [field]: next } as Partial<AIState>;
  });
}

interface Run {
  serverId: string;
  ai: AIInfo;
  settings: AISettings;
  s: Session;
  busy: Set<string>;
  again: Set<string>;
  greeted: boolean;
}

const runs = new Map<string, Run>();
const starting = new Set<string>();

/** Settings of one of my AIs as last loaded. */
export function aiSettings(serverId: string, aiId: string): AISettings {
  return parseSettings(useAI.getState().byServer[serverId]?.find((a) => a.user.id === aiId)?.settings ?? '');
}

/** Loads my AIs on a server and starts / stops the ones this device runs. */
export async function refreshAIs(serverId: string) {
  const owner = session(serverId);
  if (!owner || owner.view.status !== 'online') return;
  const fetched = await owner.listAI();
  // A slower, older answer must not undo a newer save: keep the newest per AI.
  const known = new Map((useAI.getState().byServer[serverId] ?? []).map((a) => [a.user.id, a]));
  const list = fetched.map((a) => {
    const k0 = known.get(a.user.id);
    return k0 && k0.updatedAt > a.updatedAt ? k0 : a;
  });
  useAI.setState((st) => ({ byServer: { ...st.byServer, [serverId]: list } }));
  for (const ai of list) {
    const settings = parseSettings(ai.settings);
    const key = k(serverId, ai.user.id);
    const run = runs.get(key);
    if (settings.runner?.id === deviceId()) {
      if (run) {
        run.ai = ai;
        run.settings = settings;
      } else if (!starting.has(key)) {
        // Two refreshes at once must not start it twice (the second runner would answer too).
        starting.add(key);
        await start(serverId, ai, settings).finally(() => starting.delete(key));
      }
    } else if (run) stop(key);
  }
  for (const key of [...runs.keys()]) {
    if (key.startsWith(serverId + '|') && !list.some((a) => k(serverId, a.user.id) === key)) stop(key);
  }
}

/** Saves an AI's settings (keeps a newer save from elsewhere from being overwritten). */
export async function saveSettings(serverId: string, aiId: string, settings: AISettings) {
  const owner = session(serverId)!;
  const cur = useAI.getState().byServer[serverId]?.find((a) => a.user.id === aiId);
  const info = await owner.putAISettings(aiId, JSON.stringify(settings), cur?.updatedAt ?? 0);
  useAI.setState((st) => ({ byServer: { ...st.byServer, [serverId]: (st.byServer[serverId] ?? []).map((a) => (a.user.id === aiId ? info : a)) } }));
  await refreshAIs(serverId);
}

/** Makes this device the one that runs the AI. */
export async function runHere(serverId: string, aiId: string) {
  const owner = session(serverId)!;
  await secretSet(tokenName(serverId, aiId), await owner.runAI(aiId));
  stop(k(serverId, aiId));
  await saveSettings(serverId, aiId, { ...aiSettings(serverId, aiId), runner: { id: deviceId(), name: deviceName() } });
}

async function start(serverId: string, ai: AIInfo, settings: AISettings) {
  const owner = session(serverId);
  const rec = useApp.getState().servers.find((r) => r.id === serverId);
  if (!owner || !rec) return;
  const key = k(serverId, ai.user.id);
  let token = await secretGet(tokenName(serverId, ai.user.id)).catch(() => null);
  if (!token) {
    token = await owner.runAI(ai.user.id);
    await secretSet(tokenName(serverId, ai.user.id), token);
  }
  const record: ServerRecord = { id: `ai:${serverId}:${ai.user.id}`, endpoint: rec.endpoint, name: rec.name, token, userId: ai.user.id };
  const run: Run = { serverId, ai, settings, s: null as unknown as Session, busy: new Set(), again: new Set(), greeted: false };
  run.s = new Session(
    record,
    (v) => {
      patch('running', key, v.status === 'online');
      if (v.status === 'online' && !run.greeted) {
        run.greeted = true;
        void greet(run);
      }
    },
    (r) => {
      // Logged out by the server: another device took over, or the token is gone.
      if (!r.token) {
        void secretDelete(tokenName(serverId, ai.user.id)).catch(() => {});
        stop(key);
        void refreshAIs(serverId).catch(() => {});
      }
    },
    (convId, m) => onMessage(run, convId, m),
  );
  runs.set(key, run);
  patch('running', key, false);
  await run.s.start();
}

function stop(key: string) {
  const run = runs.get(key);
  run?.s.stop();
  runs.delete(key);
  patch('running', key, undefined);
  stopMcp(key);
}

/** The first time it runs: say hello to its owner (once per chat). */
async function greet(run: Run) {
  const owner = run.ai.user.ownerId;
  if (!owner || !run.settings.persona.greeting) return;
  try {
    const convId = await run.s.openDM(owner);
    if ((run.s.view.convs[convId]?.lastSeq ?? 0) === 0) await run.s.sendText(convId, run.settings.persona.greeting, 'happy');
  } catch {
    /* try again next start */
  }
}

function onMessage(run: Run, convId: string, m: Message) {
  const conv = run.s.view.convs[convId];
  if (!conv || conv.kind !== 'dm') return; // channels come in the third batch
  if (run.settings.whoCanChat === 'owner' && m.senderId !== run.ai.user.ownerId) return;
  // The session stores the new message right after telling us: answer a tick later.
  setTimeout(() => void reply(run, convId), 0);
}

/** One tool call: permission (ask the owner when needed), run it, log it. */
async function useTool(run: Run, key: string, c: ToolCall, ctx: ToolCtx, speaker: string, step: number): Promise<AgentMsg> {
  const args = argsOf(c.args);
  const action = describeCall(c.name, args);
  const aiName = run.ai.user.name;
  const result = (content: string, images?: string[]): AgentMsg => ({ role: 'tool', callId: c.id, name: c.name, content, images });
  if (stopped(key)) {
    appendLog(key, { at: Date.now(), speaker, action, result: 'stopped' });
    return result('主人叫停了，不要再继续操作。');
  }
  setActivity(key, { aiName, action, step });
  let level = levelFor(run.settings.computer, c.name);
  const category = categoryOf(c.name);
  if (level === 'ask' && category) {
    const answer = await askOwner({ aiName, speaker, action, category });
    if (answer === 'always') {
      const cur = run.settings;
      await saveSettings(run.serverId, run.ai.user.id, { ...cur, computer: { ...cur.computer, levels: { ...cur.computer.levels, [category]: 'allow' } } }).catch(() => {});
    }
    level = answer === 'deny' ? 'deny' : 'allow';
  }
  if (level === 'deny') {
    appendLog(key, { at: Date.now(), speaker, action, result: 'denied' });
    return result('主人没有允许这个操作。换个办法，或者在聊天里跟对方说明。');
  }
  try {
    const r = await execTool(c.name, args, ctx);
    appendLog(key, { at: Date.now(), speaker, action, result: 'ok', detail: r.text.slice(0, 300) });
    return result(r.text, r.images);
  } catch (e) {
    appendLog(key, { at: Date.now(), speaker, action, result: 'error', detail: errorText(e) });
    return result(`出错了：${errorText(e)}`);
  }
}

function textOf(m: Message): string | null {
  const b = m.body;
  switch (b.kind) {
    case 'text':
      return m.struck ? null : b.text;
    case 'image':
      return '[发了一张图片]';
    case 'file':
      return `[发了一个文件：${b.name}]`;
    default:
      return null;
  }
}

async function reply(run: Run, convId: string) {
  if (run.busy.has(convId)) {
    run.again.add(convId); // answer again with the newer messages afterwards
    return;
  }
  run.busy.add(convId);
  const streamKey = k(run.serverId, convId);
  const errKey = k(run.serverId, run.ai.user.id);
  try {
    const st = run.settings;
    const providers = useProviders.getState().loaded ? useProviders.getState().list : (await loadProviders()).list;
    const p = providers.find((x) => x.id === st.providerId);
    if (!p || !st.model) throw new Error('还没选模型：打开这个 AI 的设置，在「模型」里选一个');
    const s = run.s;
    const msgs = (s.view.messages[convId] ?? []).filter((x) => !x.pending && !x.failed).slice(-st.contextSize);
    const chat = toChat(
      msgs.flatMap((x) => {
        const text = textOf(x);
        return text === null ? [] : [{ fromAI: x.senderId === run.ai.user.id, who: s.nameOf(x.senderId), text }];
      }),
      false,
    );
    if (!chat.length) return;
    const ownerName = session(run.serverId)?.view.me?.name ?? '主人';
    const speakerId = [...msgs].reverse().find((x) => x.senderId !== run.ai.user.id)?.senderId ?? '';
    const speaker = { name: s.nameOf(speakerId), isOwner: speakerId === run.ai.user.ownerId };
    const comp = st.computer;
    const agentKey = errKey;
    const mcp = await loadMcpTools(comp, agentKey);
    const tools = toolsFor(comp, mcp.defs);
    let system = systemPrompt({ name: run.ai.user.name, owner: ownerName, persona: st.persona, now: new Date() });
    if (tools.length) system += '\n\n' + computerPrompt(comp, speaker);
    if (mcp.errors.length) system += '\n\n这些 MCP 工具服务没启动成功（需要时告诉对方）：\n' + mcp.errors.join('\n');
    const turn: AgentMsg[] = [...chat];
    const ctx: ToolCtx = { computer: comp, scale: 1, mcp: mcp.map, owner: agentKey };
    let final = '';
    try {
      for (let step = 0; ; step++) {
        const req = buildRequest(p, { model: st.model, temperature: st.temperature, maxTokens: st.maxTokens, messages: turn, system, tools });
        const reader = streamReader(p.kind);
        let text = '';
        patch('streams', streamKey, '');
        const status = await aiRequest(req.url, req.headers, req.body, (chunk) => {
          text += reader.feed(chunk);
          patch('streams', streamKey, previewText(text));
        });
        if (status >= 400) throw new Error(`模型服务返回 ${status}：${errorOf(reader.raw()) || '没有说明'}`);
        const calls = reader.toolCalls();
        if (!calls.length) {
          final = text;
          break;
        }
        if (step >= comp.maxSteps) {
          final = text || '[mood:worried] 步骤太多了，我先停在这里，要继续的话再跟我说。';
          break;
        }
        turn.push({ role: 'assistant', content: text, toolCalls: calls });
        for (const c of calls) turn.push(await useTool(run, agentKey, c, ctx, speaker.name, step + 1));
        if (stopped(agentKey)) {
          final = '[mood:speechless] 好，我停下了。';
          break;
        }
      }
    } finally {
      setActivity(agentKey, null);
    }
    const { mood, text } = splitMoodTag(final);
    if (!text.trim()) throw new Error('模型没有回复内容');
    await s.sendText(convId, text.trim(), mood);
    patch('errors', errKey, undefined);
  } catch (e) {
    patch('errors', errKey, errorText(e));
  } finally {
    patch('streams', streamKey, undefined);
    run.busy.delete(convId);
    if (run.again.delete(convId)) void reply(run, convId);
  }
}

/** Watches my servers and runs my AIs (call once at start). */
export function startAI() {
  const online = new Set<string>();
  const watch = () => {
    for (const rec of useApp.getState().servers) {
      const on = session(rec.id)?.view.status === 'online';
      if (on && !online.has(rec.id)) void refreshAIs(rec.id).catch(() => {});
      if (on) online.add(rec.id);
      else online.delete(rec.id);
    }
    for (const key of [...runs.keys()]) {
      if (!useApp.getState().servers.some((r) => key.startsWith(r.id + '|'))) stop(key);
    }
  };
  useApp.subscribe(watch);
  watch();
  void loadProviders();
}
