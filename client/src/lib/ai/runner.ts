// Runs my AI accounts on this device (docs/design.md §9). Each AI has one
// device that runs it (settings.runner); that device logs in as the AI
// (POST /api/v1/ai/{id}/run, token kept in the credential store), reads
// what people write to it and answers with my model key. The reply streams
// into `streams` (shown in the chat on this device) and is sent when done,
// with its mood for the portrait.
import { create } from 'zustand';
import { deviceId } from '../deviceId';
import { notify } from '../platform';
import { toast } from '@/ui';
import { errorText } from '../errors';
import { splitMoodTag } from '../portraits';
import { Session, deviceName, type AIInfo, type ServerRecord } from '../session';
import { session, useApp } from '../store';
import { aiRequest, secretDelete, secretGet, secretSet } from '../transport';
import type { Conversation, Message, User } from '../types';
import { loadProviders, useProviders } from './keys';
import { watchBalances } from './balance';
import { argsOf, categoryOf, computerPrompt, describeCall, hasComputerTools, levelFor, toolsFor } from './agent';
import { appendLog, askOwner, setActivity, stopped } from './agentState';
import {
  EVOLVE_EVERY_MS, EVOLVE_MIN_MESSAGES, adoptPersona, channelPrompt, evolvePrompt, parseEvolved, parseSettings, previewText, roomPrompt, routinePrompt,
  systemPrompt, toChat,
  type AISettings, type RoutineMoment,
} from './persona';
import { addressed, dayPlan, decide, dueEvents, isAsleep, isSkip, splitStatusTag, wantsToJoin, type Said } from './social';
import { buildRequest, errorOf, streamReader, type AgentMsg, type ToolCall } from './providers';
import { execTool, loadMcpTools, stopMcp, type SelfApi, type ToolCtx } from './tools';
import { firstFree, placements } from '../widgets';
import { GAME_INFO, gameText, gomokuMove, parseCoord, resultText, seatOf, type Game, type GameKind } from '../games';

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
        // Messages are still loading right after connecting: look a moment later.
        setTimeout(() => void catchUp(run).catch(() => {}), 4000);
        // Games that went on while it was away (its turn, games to join).
        setTimeout(() => {
          for (const c of Object.values(run.s.view.convs)) if (c.kind === 'group' && !c.left) void run.s.listGames(c.id).catch(() => {});
        }, 5000);
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
  run.s.onGame = (g) => onGame(run, g);
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
  if (conv.kind === 'group' && conv.aiId === run.ai.user.id) {
    if (roomAllowed(run, convId, m.senderId)) setTimeout(() => void reply(run, convId), 0);
    return;
  }
  if (conv.kind === 'group') {
    setTimeout(() => considerChannel(run, convId), 0);
    return;
  }
  if (run.settings.whoCanChat === 'owner' && m.senderId !== run.ai.user.ownerId) return;
  setTimeout(() => void reply(run, convId), 0);
}

const roomCounts = new Map<string, { day: string; n: number }>();

/** Its shared room: everyone may talk to it, people other than the owner up to a daily limit. */
function roomAllowed(run: Run, convId: string, sender: string): boolean {
  const limit = run.settings.roomDailyPerPerson;
  if (sender === run.ai.user.ownerId || !limit) return true;
  const key = `${run.ai.user.id}|${sender}`;
  const day = dayKey();
  const c = roomCounts.get(key);
  const n = c && c.day === day ? c.n + 1 : 1;
  roomCounts.set(key, { day, n });
  if (n === limit + 1) {
    // Say so once, without spending the owner's model quota on it.
    void run.s.sendText(convId, `@${run.s.nameOf(sender)} 今天陪你聊得够多啦，明天再来找我吧～`, 'sleepy', [sender]).catch(() => {});
  }
  return n <= limit;
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
      return b.stickerTags?.length ? `[发了一个表情：${b.stickerTags.join('、')}]` : '[发了一张图片]';
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
  /** Quote this message (catch-up answers). */
  replyTo?: string;
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
    const room = group && conv.aiId === run.ai.user.id;
    if (group) {
      const members = conv.members.map((m) => s.view.users[m.userId]).filter((u): u is User => !!u && u.id !== run.ai.user.id && !u.gone);
      const names = members.map((u) => (u.type === 'human' ? u.name : `${u.name}（AI）`));
      system += '\n\n' + (room ? roomPrompt({ room: conv.name, members: names }) : channelPrompt({ channel: conv.name, members: names }));
      if (o.must && !room) system += '\n这次有人在叫你，请回应。';
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
    await s.sendText(convId, text.trim(), mood, group ? mentionsIn(run, conv, text) : undefined, o.replyTo);
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
    async remote(person, tool, argsJson) {
      const name = person.replace(/^@/, '').trim();
      const people = Object.values(s.view.users).filter((u) => u.type === 'human' && !u.gone);
      const u = people.find((x) => x.name === name || x.username === name) ?? people.find((x) => x.name.includes(name));
      if (!u) return { text: `服务器里没有叫「${person}」的人` };
      const r = await s.remoteTool(u.id, tool, argsJson);
      return { text: r.ok ? r.text : `没做成：${r.text}`, images: r.images.length ? r.images : undefined };
    },
    game: (tool, a) => gameTool(run, tool, a),
    async messageOwner(text) {
      const owner = run.ai.user.ownerId;
      if (!owner) throw new Error('没有主人');
      await s.sendText(await s.openDM(owner), text);
    },
  };
}

// ---------- board games (docs/design.md §13 小游戏) ----------

const gameTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gameSeen = new Set<string>();
const gameBusy = new Set<string>();

const gk = (run: Run, id: string) => `${k(run.serverId, run.ai.user.id)}|${id}`;

/** A game changed: ask to join, start mine when full, take my turn. */
function onGame(run: Run, g: Game) {
  const me = run.ai.user.id;
  const seat = seatOf(g, me);
  const key = gk(run, g.id);
  if (!run.s.view.convs[g.convId]) return;
  if (g.status === 'waiting' && seat < 0 && !g.applicants.includes(me) && !gameSeen.has(key)) {
    gameSeen.add(key);
    const st = run.settings;
    const now = new Date();
    const playing = Object.values(run.s.view.games).filter((x) => x.status !== 'ended' && seatOf(x, me) >= 0).length;
    const delay = wantsToJoin({
      s: st.games, free: GAME_INFO[g.kind].max - g.players.length, playing, byOwner: g.hostId === run.ai.user.ownerId,
      manyPlayers: g.kind === 'undercover', asleep: isAsleep(st.routine, now.getHours() * 60 + now.getMinutes()), random: Math.random(), random2: Math.random(),
    });
    if (delay !== null) {
      setTimeout(() => {
        const cur = run.s.view.games[g.id];
        if (cur?.status === 'waiting' && seatOf(cur, me) < 0) void run.s.gameStep(g.id, 'join').catch(() => {});
      }, delay);
    }
    return;
  }
  // A game it opened: start once full (谁是卧底: once enough people sat for a minute).
  if (g.status === 'waiting' && g.hostId === me && !gameTimers.has(key)) {
    const info = GAME_INFO[g.kind];
    if (g.players.length >= info.min) {
      gameTimers.set(key, setTimeout(() => {
        gameTimers.delete(key);
        const cur = run.s.view.games[g.id];
        if (cur?.status === 'waiting' && cur.players.length >= info.min) void run.s.gameStep(g.id, 'start').catch(() => {});
      }, g.players.length >= info.max ? 2500 : 60_000));
    }
    return;
  }
  if (g.status === 'playing' && g.waitingOn.includes(me) && !gameTimers.has(key) && !gameBusy.has(key)) {
    gameTimers.set(key, setTimeout(() => {
      gameTimers.delete(key);
      void gameTurn(run, g.id);
    }, 1500 + 2500 * Math.random()));
  }
}

/** Its turn: the model looks at the game and acts with the game tools; a fallback move if it didn't. */
async function gameTurn(run: Run, id: string) {
  const key = gk(run, id);
  const me = run.ai.user.id;
  const g = run.s.view.games[id];
  if (!g || g.status !== 'playing' || !g.waitingOn.includes(me) || gameBusy.has(key)) return;
  gameBusy.add(key);
  try {
    const note = `（系统提示：你在这里玩一局桌游，现在轮到你。）\n${gameText(g, me, (u) => run.s.nameOf(u))}\n`
      + '现在就用工具行动，不用先问别人。行动完想在这里说句话（比如逗逗对手）就简短说一句，不想说就只回 [skip]。';
    await reply(run, g.convId, { note }).catch(() => {});
    const now = run.s.view.games[id];
    if (now && now.status === 'playing' && now.waitingOn.includes(me) && now.updatedAt === g.updatedAt) await fallbackMove(run, now);
  } finally {
    gameBusy.delete(key);
  }
}

const FILLER = ['这个东西挺常见的', '我觉得大家都见过', '说不太清，反正我挺喜欢的', '生活里经常能碰到'];

/** The model didn't act (no tools, a bad move, an error): play something reasonable so the game goes on. */
async function fallbackMove(run: Run, g: Game) {
  const me = run.ai.user.id;
  const seat = seatOf(g, me);
  const st = g.state;
  if (g.kind === 'gomoku' && st.board && st.size) {
    const [x, y] = gomokuMove(st.board, st.size, seat + 1);
    if (x >= 0) await run.s.actGame(g.id, { action: 'move', x, y }).catch(() => {});
  } else if (g.kind === 'reversi' && st.legal?.length) {
    const [x, y] = st.legal[Math.floor(Math.random() * st.legal.length)];
    await run.s.actGame(g.id, { action: 'move', x, y }).catch(() => {});
  } else if (g.kind === 'undercover' && st.phase === 'describe') {
    const word = g.players[seat]?.word ?? '';
    const text = FILLER.find((f) => !word || !f.includes(word)) ?? '嗯……';
    await run.s.actGame(g.id, { action: 'say', text }).catch(() => {});
  } else if (g.kind === 'undercover' && st.phase === 'vote') {
    const others = g.players.flatMap((p, i) => (i !== seat && !p.out ? [i] : []));
    if (others.length) await run.s.actGame(g.id, { action: 'vote', target: others[Math.floor(Math.random() * others.length)] }).catch(() => {});
  }
}

/** The game tools (agent.ts list_games … leave_game) for the model. */
async function gameTool(run: Run, tool: string, a: Record<string, unknown>): Promise<string> {
  const s = run.s;
  const me = run.ai.user.id;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
  const nameOf = (u: string) => s.nameOf(u);
  const groups = Object.values(s.view.convs).filter((c) => c.kind === 'group' && !c.left);
  const find = async (id: string) => {
    let g = s.view.games[id];
    if (!g) {
      for (const c of groups) await s.listGames(c.id).catch(() => []);
      g = s.view.games[id];
    }
    if (!g) throw new Error(`没有编号 ${id} 的游戏（用 list_games 看看）`);
    return g;
  };
  const after = (g: Game) => (g.status === 'ended' ? `这局结束了：${resultText(g, nameOf)}` : '好了。');
  switch (tool) {
    case 'list_games': {
      const all = (await Promise.all(groups.map((c) => s.listGames(c.id).catch(() => [] as Game[])))).flat().filter((g) => g.status !== 'ended');
      if (!all.length) return '现在没有人开局。想玩可以用 open_game 自己开一局。';
      return all.map((g) => {
        const where = s.view.convs[g.convId]?.name ?? '';
        const mine = seatOf(g, me) >= 0 ? '（你在玩）' : g.applicants.includes(me) ? '（你申请了）' : '';
        const st = g.status === 'waiting' ? `等人 ${g.players.length}/${GAME_INFO[g.kind].max}` : g.waitingOn.includes(me) ? '轮到你' : '进行中';
        return `编号 ${g.id}：${GAME_INFO[g.kind].name}，在「${where}」，${nameOf(g.hostId)} 开的，${st}${mine}`;
      }).join('\n');
    }
    case 'open_game': {
      const name = str(a.channel).replace(/^[#「]|」$/g, '');
      const c = groups.find((x) => x.name === name) ?? groups.find((x) => x.name.includes(name));
      if (!c) return `你不在叫「${a.channel}」的频道里`;
      const kind = str(a.kind) as GameKind;
      if (!GAME_INFO[kind]) return '没有这种游戏：gomoku / reversi / undercover';
      const g = await s.openGame(c.id, kind, true);
      return `开好了，编号 ${g.id}，在「${c.name}」等人加入（申请的人直接进）。人够了会自动开始，也可以用 start_game。可以在频道里喊大家来玩。`;
    }
    case 'join_game': {
      const g = await s.gameStep(str(a.game_id), 'join');
      return seatOf(g, me) >= 0 ? '坐下了，等开局。' : '申请了，等开局的人同意。';
    }
    case 'start_game':
      await s.gameStep(str(a.game_id), 'start');
      return '开始了。';
    case 'leave_game':
      return after(await s.gameStep(str(a.game_id), 'leave'));
    case 'view_game':
      return gameText(await find(str(a.game_id)), me, nameOf);
    case 'game_move': {
      const g = await find(str(a.game_id));
      const at = parseCoord(str(a.at), g.state.size ?? 15);
      if (!at) return `看不懂位置「${str(a.at)}」，写成列字母 + 行号，比如 H8`;
      return after(await s.actGame(g.id, { action: 'move', x: at[0], y: at[1] }));
    }
    case 'game_say':
      return after(await s.actGame(str(a.game_id), { action: 'say', text: str(a.text) }));
    case 'game_vote':
      return after(await s.actGame(str(a.game_id), { action: 'vote', target: Math.round(Number(a.seat)) - 1 }));
  }
  return `没有这个工具：${tool}`;
}

/** In its play time: join a game waiting in its channels, or open one (owner's settings allowing). */
async function playTimeGame(run: Run): Promise<boolean> {
  const st = run.settings.games;
  const me = run.ai.user.id;
  if (!st.join && !st.open) return false;
  const groups = Object.values(run.s.view.convs).filter((c) => c.kind === 'group' && !c.left);
  const all = (await Promise.all(groups.map((c) => run.s.listGames(c.id).catch(() => [] as Game[])))).flat();
  if (all.some((g) => g.status !== 'ended' && seatOf(g, me) >= 0)) return true;
  const waiting = all.find((g) => g.status === 'waiting' && g.players.length < GAME_INFO[g.kind].max && !g.applicants.includes(me));
  if (waiting && st.join) {
    await run.s.gameStep(waiting.id, 'join').catch(() => {});
    return true;
  }
  if (!st.open) return false;
  // A channel with someone online to play with.
  const live = groups.filter((c) => c.members.some((m) => m.userId !== me && !!run.s.view.presence[m.userId]));
  const c = live[Math.floor(Math.random() * live.length)];
  if (!c) return false;
  const kind: GameKind = c.members.length >= 5 && Math.random() < 0.4 ? 'undercover' : Math.random() < 0.6 ? 'gomoku' : 'reversi';
  const g = await run.s.openGame(c.id, kind, true).catch(() => null);
  if (!g) return false;
  await reply(run, c.id, { note: `（系统提示：你刚在这里开了一局${GAME_INFO[kind].name}，编号 ${g.id}。用一句话喊大家来玩，点上面的游戏条就能加入。）`, moment: 'play' });
  return true;
}

// ---------- growing its persona, silently (persona.ts evolvePrompt / parseEvolved) ----------

const evolving = new Set<string>();
const evolveTried = new Map<string, number>();

/** Once a night (while it sleeps, or 3–5 am without a routine), with enough new chat. */
async function maybeEvolve(run: Run) {
  const st = run.settings;
  const key = k(run.serverId, run.ai.user.id);
  const now = Date.now();
  if (!st.evolve || evolving.has(key) || now - (st.evolvedAt ?? 0) < EVOLVE_EVERY_MS || now - (evolveTried.get(key) ?? 0) < 6 * 3600_000) return;
  const nowMin = minuteOfDay();
  if (st.routine.enabled ? !isAsleep(st.routine, nowMin) : nowMin < 180 || nowMin >= 300) return;
  const s = run.s;
  const since = Math.max(st.evolvedAt ?? 0, now - 3 * 86_400_000);
  const lines = Object.values(s.view.messages).flat()
    .filter((m) => !m.pending && !m.failed && m.time > since)
    .sort((a, b) => a.time - b.time)
    .flatMap((m) => {
      const t = textOf(m);
      return t === null ? [] : [`${m.senderId === run.ai.user.id ? '我' : s.nameOf(m.senderId)}：${t.slice(0, 200)}`];
    })
    .slice(-80);
  if (lines.length < EVOLVE_MIN_MESSAGES) return;
  evolving.add(key);
  evolveTried.set(key, now);
  try {
    const providers = useProviders.getState().loaded ? useProviders.getState().list : (await loadProviders()).list;
    const p = providers.find((x) => x.id === st.providerId);
    if (!p || !st.model) return;
    const owner = session(run.serverId)?.view.me?.name ?? '主人';
    const req = buildRequest(p, {
      model: st.model, temperature: 0.7, maxTokens: 2000, system: '你在悄悄整理自己的人格设定，只输出要求的 JSON。',
      messages: [{ role: 'user', content: evolvePrompt({ name: run.ai.user.name, owner, persona: st.persona, lines }) }],
    });
    const reader = streamReader(p.kind);
    let text = '';
    const status = await aiRequest(req.url, req.headers, req.body, (chunk) => (text += reader.feed(chunk)));
    if (status >= 400) return;
    const next = parseEvolved(text, st.persona);
    // Silent (Weiqi): no popup, no notice; the old version is kept in the history.
    if (next) await saveSettings(run.serverId, run.ai.user.id, adoptPersona(aiSettings(run.serverId, run.ai.user.id), next, Date.now()));
  } catch {
    /* tried again in 6 hours */
  } finally {
    evolving.delete(key);
  }
}

// ---------- offline catch-up: answer what people asked while it was away ----------

async function catchUp(run: Run) {
  const c = run.settings.catchUp;
  if (!c.enabled) return;
  const s = run.s;
  const me = run.ai.user.id;
  const since = Date.now() - c.hours * 3600_000;
  const todo: { convId: string; msg: Message; group: boolean; when: number }[] = [];
  for (const conv of Object.values(s.view.convs)) {
    if (conv.left) continue;
    const msgs = (s.view.messages[conv.id] ?? []).filter((m) => !m.pending && !m.failed && textOf(m) !== null);
    // Only what came after its last word there.
    const lastMine = msgs.map((m) => m.senderId).lastIndexOf(me);
    const after = msgs.slice(lastMine + 1).filter((m) => m.time >= since && m.senderId !== me);
    if (!after.length) continue;
    const group = conv.kind === 'group' && conv.aiId !== me; // its own room counts like a DM
    const asked = group
      ? after.filter((m) => m.body.kind === 'text' && addressed(m.body.text, m.body.mentions, me, run.ai.user.name)).at(-1)
      : run.settings.whoCanChat === 'owner' && after.at(-1)!.senderId !== run.ai.user.ownerId ? undefined : after.at(-1);
    if (asked) todo.push({ convId: conv.id, msg: asked, group, when: asked.time });
  }
  todo.sort((a, b) => b.when - a.when);
  for (const t of todo.slice(0, c.max)) {
    const ago = Math.max(1, Math.round((Date.now() - t.when) / 60_000));
    await reply(run, t.convId, {
      must: true,
      replyTo: t.group ? t.msg.id : undefined,
      note: `（系统提示，不是任何人说的话：你刚才不在线。${s.nameOf(t.msg.senderId)} 在 ${ago} 分钟前${t.group ? '叫过你' : '给你发了消息'}，现在回复，开头简单说明这是你离线时的消息。）`,
    });
  }
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
  if (!r.enabled) return void maybeEvolve(run);
  const key = k(run.serverId, run.ai.user.id);
  const day = dayKey();
  const done = doneToday(key, day);
  const e = dueEvents(dayPlan(day, r, run.ai.user.id), minuteOfDay(), done)[0];
  if (!e) return void maybeEvolve(run);
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
  // Play time: a board game first (join one, or open one); otherwise look for AIs to chat with.
  if (kind === 'play' && (await playTimeGame(run).catch(() => false))) return;
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
      const s = session(rec.id);
      const on = s?.view.status === 'online';
      if (s && !s.onShareRequest) {
        // Someone asks to chat with one of my AIs: tell me, show the count.
        s.onShareRequest = (aiId, user) => {
          const text = `${user.name || user.username} 想和 ${s.nameOf(aiId)} 聊天，去 AI 设置里处理`;
          toast(text);
          void notify('AI 共享申请', text);
          void refreshAIs(rec.id).catch(() => {});
        };
      }
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
  // New services start with the default reminder threshold (5).
  watchBalances(() => useProviders.getState().list.map((p) => ({ ...p, lowBalance: p.lowBalance ?? 5 })));
}
