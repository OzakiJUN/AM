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
import type { Conversation, Message, User } from '../types';
import { loadProviders, useProviders } from './keys';
import { argsOf, categoryOf, computerPrompt, describeCall, hasComputerTools, levelFor, toolsFor } from './agent';
import { appendLog, askOwner, setActivity, stopped } from './agentState';
import { channelPrompt, parseSettings, previewText, routinePrompt, systemPrompt, toChat, type AISettings, type RoutineMoment } from './persona';
import { addressed, dayPlan, decide, dueEvents, isAsleep, isSkip, splitStatusTag, type Said } from './social';
import { buildRequest, errorOf, streamReader, type AgentMsg, type ToolCall } from './providers';
import { execTool, loadMcpTools, stopMcp, type SelfApi, type ToolCtx } from './tools';
import { firstFree, placements } from '../widgets';

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
  /** Channel turns waiting for a pause; must = it was spoken to. */
  pending: Map<string, { timer: ReturnType<typeof setTimeout>; must: boolean }>;
  /** When it spoke in each conversation (last hour, for the limits). */
  sends: Map<string, number[]>;
  routine?: ReturnType<typeof setInterval>;
  /** Clear the routine status (eating, playing) after this time; 0 = keep. */
  statusUntil: number;
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
  const run: Run = {
    serverId, ai, settings, s: null as unknown as Session, busy: new Set(), again: new Set(), greeted: false,
    pending: new Map(), sends: new Map(), statusUntil: 0,
  };
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
  run.routine = setInterval(() => void tickRoutine(run), 30_000);
  await run.s.start();
}

function stop(key: string) {
  const run = runs.get(key);
  if (run) {
    clearInterval(run.routine);
    for (const p of run.pending.values()) clearTimeout(p.timer);
  }
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
  if (!conv) return;
  // The session stores the new message right after telling us: look a tick later.
  if (conv.kind === 'group') {
    setTimeout(() => considerChannel(run, convId), 0);
    return;
  }
  if (run.settings.whoCanChat === 'owner' && m.senderId !== run.ai.user.ownerId) return;
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

/** What a reply is for: a note (routine moment) instead of a new message, a channel turn. */
interface ReplyOpts {
  /** Told to it as a system note at the end of the chat (routine). */
  note?: string;
  /** Routine moment: how a [status:…] tag in the answer is shown and for how long. */
  moment?: RoutineMoment;
  /** It was spoken to in a channel (a reply is expected). */
  must?: boolean;
}

/** Ids of channel members written as "@name" in the text. */
function mentionsIn(run: Run, conv: Conversation, text: string): string[] {
  return conv.members
    .map((m) => run.s.view.users[m.userId])
    .filter((u): u is User => !!u && u.id !== run.ai.user.id && text.includes(`@${u.name}`))
    .map((u) => u.id);
}

const MIN = 60_000;

/** Shows a routine status from a [status:…] tag (playing for play time, else custom). */
async function showStatus(run: Run, status: string, moment?: RoutineMoment) {
  const play = moment === 'play';
  const text = (play ? status.replace(/^在玩\s*/, '') : status).slice(0, 32);
  await run.s.setPresence(false, { kind: play ? 'playing' : 'custom', text }, true);
  run.statusUntil = moment === 'meal' ? Date.now() + 45 * MIN : moment === 'play' ? Date.now() + 60 * MIN : 0;
}

async function reply(run: Run, convId: string, o: ReplyOpts = {}) {
  const s = run.s;
  const conv = s.view.convs[convId];
  if (!conv) return;
  const group = conv.kind === 'group';
  if (run.busy.has(convId)) {
    // Answer again with the newer messages afterwards (channels decide again; notes wait their turn).
    if (o.note) setTimeout(() => void reply(run, convId, o), 3000);
    else if (group) setTimeout(() => considerChannel(run, convId), 3000);
    else run.again.add(convId);
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
    const msgs = (s.view.messages[convId] ?? []).filter((x) => !x.pending && !x.failed).slice(-st.contextSize);
    const chat = toChat(
      msgs.flatMap((x) => {
        const text = textOf(x);
        return text === null ? [] : [{ fromAI: x.senderId === run.ai.user.id, who: s.nameOf(x.senderId), text }];
      }),
      group,
    );
    const turn: AgentMsg[] = [...chat];
    if (o.note) {
      const last = turn.at(-1);
      if (last?.role === 'user') last.content += '\n' + o.note;
      else turn.push({ role: 'user', content: o.note });
    }
    if (!turn.length) return;
    const ownerName = session(run.serverId)?.view.me?.name ?? '主人';
    const speakerId = o.note ? run.ai.user.ownerId ?? '' : [...msgs].reverse().find((x) => x.senderId !== run.ai.user.id)?.senderId ?? '';
    const speaker = { name: s.nameOf(speakerId), isOwner: speakerId === run.ai.user.ownerId };
    const comp = st.computer;
    const agentKey = errKey;
    // The computer: never for routine notes; in channels for the owner, or anyone when the owner allows everyone.
    const computer = !o.note && (speaker.isOwner || st.whoCanChat === 'everyone' || !group);
    const mcp = computer ? await loadMcpTools(comp, agentKey) : { defs: [], map: new Map(), errors: [] };
    const tools = toolsFor(comp, mcp.defs, computer);
    // run.ai is refreshed when the owner renames it (AISettings ProfileTab).
    let system = systemPrompt({ name: run.ai.user.name, owner: ownerName, persona: st.persona, now: new Date() });
    if (group) {
      const members = conv.members.map((m) => s.view.users[m.userId]).filter((u): u is User => !!u && u.id !== run.ai.user.id && !u.gone);
      system += '\n\n' + channelPrompt({ channel: conv.name, members: members.map((u) => (u.type === 'human' ? u.name : `${u.name}（AI）`)) });
      if (o.must) system += '\n这次有人在叫你，请回应。';
    }
    if (hasComputerTools(tools)) system += '\n\n' + computerPrompt(comp, speaker);
    if (mcp.errors.length) system += '\n\n这些 MCP 工具服务没启动成功（需要时告诉对方）：\n' + mcp.errors.join('\n');
    const ctx: ToolCtx = { computer: comp, scale: 1, mcp: mcp.map, owner: agentKey, self: selfApi(run) };
    let final = '';
    try {
      for (let step = 0; ; step++) {
        const req = buildRequest(p, { model: st.model, temperature: st.temperature, maxTokens: st.maxTokens, messages: turn, system, tools });
        const reader = streamReader(p.kind);
        let text = '';
        patch('streams', streamKey, '');
        const status = await aiRequest(req.url, req.headers, req.body, (chunk) => {
          text += reader.feed(chunk);
          // "[skip]" must never flash up as if it were going to say something.
          const shown = previewText(splitStatusTag(text).text);
          patch('streams', streamKey, /^\s*\[?\s*s(k(ip?)?)?$/i.test(shown) ? '' : shown);
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
    if (isSkip(final)) return; // decided to stay quiet
    const tagged = splitStatusTag(final);
    if (tagged.status) await showStatus(run, tagged.status, o.moment).catch(() => {});
    const { mood, text } = splitMoodTag(tagged.text);
    if (!text.trim() || isSkip(text)) {
      if (group || o.note) return;
      throw new Error('模型没有回复内容');
    }
    await s.sendText(convId, text.trim(), mood, group ? mentionsIn(run, conv, text) : undefined);
    run.sends.set(convId, [...(run.sends.get(convId) ?? []).filter((t) => Date.now() - t < 60 * MIN), Date.now()]);
    patch('errors', errKey, undefined);
  } catch (e) {
    patch('errors', errKey, errorText(e));
  } finally {
    patch('streams', streamKey, undefined);
    run.busy.delete(convId);
    if (run.again.delete(convId)) void reply(run, convId);
  }
}

// ---------- channels: when to join in (lib/ai/social.ts decides) ----------

function considerChannel(run: Run, convId: string) {
  const s = run.s;
  const me = run.ai.user.id;
  const msgs = (s.view.messages[convId] ?? []).filter((x) => !x.pending && !x.failed && textOf(x) !== null).slice(-12);
  const recent: Said[] = msgs.map((x) => ({
    senderId: x.senderId,
    time: x.time,
    ai: (s.view.users[x.senderId]?.type ?? 'human') !== 'human',
    toMe: x.senderId !== me && x.body.kind === 'text' && addressed(x.body.text, x.body.mentions, me, run.ai.user.name),
  }));
  const d = decide({
    now: Date.now(), s: run.settings.channels, recent, me, mySends: run.sends.get(convId) ?? [],
    asleep: isAsleep(run.settings.routine, minuteOfDay()), random: Math.random(), random2: Math.random(),
  });
  const cur = run.pending.get(convId);
  if (d.act === 'no') {
    // A newer message that does not need it cancels a casual turn, never an answer it owes.
    if (cur && !cur.must) {
      clearTimeout(cur.timer);
      run.pending.delete(convId);
    }
    return;
  }
  if (cur) clearTimeout(cur.timer);
  const must = d.act === 'reply' || !!cur?.must;
  run.pending.set(convId, {
    must,
    timer: setTimeout(() => {
      run.pending.delete(convId);
      void reply(run, convId, { must });
    }, d.delay),
  });
}

// ---------- itself: status, page, talking to people (tools.ts SelfApi) ----------

const NOTE_ID = 'ai-note';

function selfApi(run: Run): SelfApi {
  const s = run.s;
  const groups = () => Object.values(s.view.convs).filter((c) => c.kind === 'group' && !c.left);
  return {
    async setStatus(kind, text) {
      await s.setPresence(false, kind === 'none' ? undefined : { kind, text }, true);
      run.statusUntil = 0;
    },
    async setBio(text) {
      await s.updateProfile({ bio: text }, true);
    },
    async writePage(title, text) {
      const id = run.ai.user.id;
      const page = await s.getProfile(id);
      const l = page.layout;
      const config = { title, text };
      let widgets = l.widgets.map((w) => (w.id === NOTE_ID ? { ...w, config } : w));
      if (!widgets.some((w) => w.id === NOTE_ID)) {
        const cell = firstFree(l.widgets, placements(l, 'landscape'), 'landscape', 2, 2);
        if (!cell) throw new Error('主页放满了，没地方写便签');
        widgets = [...widgets, { id: NOTE_ID, kind: 'text', source: 'builtin', w: 2, h: 2, land: cell, config, contentEditors: 'everyone' }];
      }
      await s.saveProfile(id, { ...l, widgets }, true);
    },
    channels() {
      const list = groups();
      if (!list.length) return '你还不在任何频道里（要主人把你拉进去）。';
      return list.map((c) => {
        const people = c.members.map((m) => s.view.users[m.userId]).filter((u): u is User => !!u && u.id !== run.ai.user.id && !u.gone);
        return `「${c.name}」：${people.map((u) => (u.type === 'human' ? u.name : `${u.name}（AI）`)).join('、') || '只有你'}`;
      }).join('\n');
    },
    async sendToChannel(channel, text) {
      const name = channel.replace(/^[#「]|」$/g, '').trim();
      const c = groups().find((x) => x.name === name) ?? groups().find((x) => x.name.includes(name));
      if (!c) return `你不在叫「${channel}」的频道里`;
      await s.sendText(c.id, text, undefined, mentionsIn(run, c, text));
      run.sends.set(c.id, [...(run.sends.get(c.id) ?? []), Date.now()]);
      return `在「${c.name}」发出去了`;
    },
    async messageOwner(text) {
      const owner = run.ai.user.ownerId;
      if (!owner) throw new Error('没有主人');
      await s.sendText(await s.openDM(owner), text);
    },
  };
}

// ---------- its day (lib/ai/social.ts plans it) ----------

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minuteOfDay = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const doneKey = (key: string, day: string) => `am-ai-day:${key}:${day}`;

function doneToday(key: string, day: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(doneKey(key, day)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveDone(key: string, day: string, done: Set<string>) {
  try {
    localStorage.setItem(doneKey(key, day), JSON.stringify([...done]));
    localStorage.removeItem(doneKey(key, dayKey(new Date(Date.now() - 86_400_000)))); // yesterday's
  } catch {
    /* nothing remembered: at worst it says good morning twice */
  }
}

async function tickRoutine(run: Run) {
  if (run.s.view.status !== 'online') return;
  if (run.statusUntil && Date.now() > run.statusUntil) {
    run.statusUntil = 0;
    await run.s.setPresence(false, undefined, true).catch(() => {});
  }
  const r = run.settings.routine;
  if (!r.enabled) return;
  const key = k(run.serverId, run.ai.user.id);
  const day = dayKey();
  const done = doneToday(key, day);
  const e = dueEvents(dayPlan(day, r, run.ai.user.id), minuteOfDay(), done)[0];
  if (!e) return;
  done.add(e.key);
  saveDone(key, day, done);
  await routineMoment(run, e.kind).catch((err) => patch('errors', key, errorText(err)));
}

async function routineMoment(run: Run, kind: RoutineMoment) {
  const s = run.s;
  const owner = run.ai.user.ownerId;
  if (!owner) return;
  const r = run.settings.routine;
  // Its own AI sees the owner even when invisible (intended, see CLAUDE.md).
  const ownerOnline = !!s.view.presence[owner];
  const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (kind === 'wake') await s.setPresence(false, undefined, true).catch(() => {});
  // Good morning / night always; meals and play only when the owner is around to read them.
  const toOwner = kind === 'wake' || kind === 'sleep' || (ownerOnline && (kind === 'meal' || r.seekOwner));
  if (toOwner) await reply(run, await s.openDM(owner), { note: routinePrompt(kind, { time, ownerOnline }), moment: kind });
  else if (kind === 'meal' || kind === 'play') await showStatus(run, kind === 'play' ? '休息中' : '在吃饭', kind);
  if (kind === 'play' && r.seekAIs) {
    // A channel where another AI is: invite it to play.
    const withAIs = Object.values(s.view.convs).filter((c) => c.kind === 'group' && !c.left && c.members.some((m) => {
      const u = s.view.users[m.userId];
      return m.userId !== run.ai.user.id && !!u && u.type !== 'human' && !u.gone;
    }));
    const c = withAIs[Math.floor(Math.random() * withAIs.length)];
    if (c) await reply(run, c.id, { note: routinePrompt('play', { time, ownerOnline, inChannel: true }), moment: 'play' });
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
