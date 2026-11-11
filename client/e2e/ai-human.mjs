// The runner behaving like a person (docs/design.md §9 像群友): a game turn
// that comes round again while it is busy is not lost; a channel reply shows
// "正在输入…", does not stream, and comes as one message per paragraph.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const state = { requests: 0, replies: [], typing: 0, sent: [], acts: [], pins: [], stickers: [], presence: [] };
globalThis.__amHuman = state;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const server = await createServer({ server: { middlewareMode: true, hmr: false }, plugins: [{
  name: 'human-boundaries', enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/src/lib/ai/runner.ts')) return code.replace("from '../transport'", "from 'virtual:human-transport'").replace("from './tools'", "from 'virtual:human-tools'") + '\nexport const testRunner = { reply, onGame, gameTurn, runs };';
  },
  resolveId(id) { if (id.startsWith('virtual:human-')) return '\0' + id; },
  load(id) {
    if (id === '\0virtual:human-transport') return `
      export async function secretDelete(){};export async function secretGet(){return null};export async function secretSet(){};
      export async function aiRequest(url,headers,body,onChunk){
        const s=globalThis.__amHuman;s.requests++;
        const content=s.replies.shift() ?? '[skip]';
        onChunk('data: '+JSON.stringify({model:'m',choices:[{delta:{content}}]})+'\\n\\n');return 200;
      }`;
    if (id === '\0virtual:human-tools') return `
      export async function loadMcpTools(){return {defs:[],map:new Map(),errors:[]}};export function stopMcp(){};
      export const biliLogin={status:async()=>({login:false,name:''})};
      export async function execTool(){return {text:'ok'}};`;
  },
}] });
try {
  const { testRunner, useAI } = await server.ssrLoadModule('/src/lib/ai/runner.ts');
  const { defaultSettings } = await server.ssrLoadModule('/src/lib/ai/persona.ts');
  const { emptyMemory } = await server.ssrLoadModule('/src/lib/ai/memory.ts');
  const { useProviders } = await server.ssrLoadModule('/src/lib/ai/keys.ts');
  useProviders.setState({ loaded: true, list: [{ id: 'p', name: 'X', kind: 'openai', baseUrl: 'https://example.com/v1', key: 'fake' }] });
  const settings = { ...defaultSettings(), model: 'm', providerId: 'p' };
  const members = [{ userId: '1' }, { userId: '2' }];
  const view = {
    status: 'online', convs: { '20': { id: '20', kind: 'group', name: '棋社', members, lastSeq: 1 } }, messages: { '20': [] }, replyTargets: {}, games: {},
    users: { '1': { id: '1', type: 'human', name: '主人' }, '2': { id: '2', type: 'ai', name: '大肥鱼', ownerId: '1' } },
  };
  const run = { serverId: 'srv', ai: { user: { id: '2', name: '大肥鱼', ownerId: '1' } }, settings, busy: new Set(), again: new Set(), pending: new Map(), sends: new Map(), helper: { cmds: [], at: Date.now() }, memory: emptyMemory(), memoryAt: 0, memoryLoaded: true, memoryQueue: Promise.resolve(), s: {
    view, nameOf: id => view.users[id]?.name ?? id,
    sendTyping: () => { state.typing++; },
    sendText: async (convId, text, mood, mentions, replyTo) => { state.sent.push({ text, replyTo, at: Date.now() }); },
    actGame: async (id, a) => {
      state.acts.push(a);
      const g = view.games[id];
      // The first move: the other player answers at once and it is its turn again.
      view.games[id] = { ...g, updatedAt: Date.now(), waitingOn: state.acts.length === 1 ? ['2'] : ['1'] };
      return view.games[id];
    },
    putClientState: async () => 1, listGames: async () => [],
    placeEmoji: async (convId, target, emoji, x, y, remove, onBubble) => { state.pins.push({ target, emoji, onBubble }); },
    listStickers: async () => [{ mediaId: 'm-own', tags: ['猫猫'] }],
    stickerLibrary: async (q) => ({ items: [{ mediaId: 'm-lib', tags: ['笑死', '哈哈'] }], next: 0, disabled: false }),
    sendSticker: async (convId, st) => { state.stickers.push(st); },
    setPresence: async (invisible, activity) => { state.presence.push(activity); },
  } };
  testRunner.runs.set('srv|2', run);

  // 1. A channel reply: typing shown, nothing streamed, paragraphs as separate messages.
  const trigger = { id: 'm1', seq: 1, senderId: '1', time: Date.now(), body: { kind: 'text', text: '@大肥鱼 新版本怎么样', mentions: ['2'] } };
  view.messages['20'] = [trigger];
  state.replies.push('哈哈\n这个我知道，是上周出的新版本\n\n不过听说有点卡');
  let streamed = false;
  const unsub = useAI.subscribe((st) => { if (st.streams['srv|20'] !== undefined) streamed = true; });
  const t0 = Date.now();
  await testRunner.reply(run, '20', { must: true, trigger });
  unsub();
  assert.equal(streamed, false, 'channel replies do not stream');
  assert.ok(state.typing >= 1, '"正在输入…" was sent');
  assert.deepEqual(state.sent.map((m) => m.text), ['哈哈\n这个我知道，是上周出的新版本', '不过听说有点卡']);
  assert.equal(state.sent[0].replyTo, 'm1');
  assert.equal(state.sent[1].replyTo, undefined);
  assert.ok(state.sent[1].at - state.sent[0].at >= 1000, 'the second one after typing it');
  assert.ok(state.sent[0].at - t0 >= 1000, 'not instantly');

  // 2. A game turn that comes round again while it is still busy is played too.
  view.games['g1'] = { id: 'g1', kind: 'gomoku', convId: '20', status: 'playing', hostId: '1', players: [{ userId: '2' }, { userId: '1' }], waitingOn: ['2'], applicants: [], state: { size: 15, board: Array(225).fill(0) }, updatedAt: Date.now() - 1000 };
  await testRunner.gameTurn(run, 'g1');
  assert.equal(state.acts.length, 1, 'first move (fallback, the model only said [skip])');
  for (let i = 0; i < 80 && state.acts.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(state.acts.length, 2, 'its turn again: played without being told');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.acts.length, 2, 'then the other player');
  // 3. A reaction on the message it answers, words, then a sticker from the library.
  state.sent.length = 0;
  const t2 = { id: 'm2', seq: 2, senderId: '1', time: Date.now(), body: { kind: 'text', text: '@大肥鱼 我又输了', mentions: ['2'] } };
  view.messages['20'] = [trigger, t2];
  state.replies.push('[mood:laugh] [react:😂] 笑死 [sticker:笑死]');
  await testRunner.reply(run, '20', { must: true, trigger: t2 });
  assert.deepEqual(state.pins, [{ target: 'm2', emoji: '😂', onBubble: true }]);
  assert.deepEqual(state.sent.map((m) => m.text), ['笑死']);
  assert.deepEqual(state.stickers, [{ mediaId: 'm-lib', tags: ['笑死', '哈哈'] }]);
  assert.equal(run.mood.key, 'laugh', 'the mood lingers for its next replies');
  // Only a reaction: nothing said.
  state.sent.length = 0;
  state.replies.push('[react:👍]');
  await testRunner.reply(run, '20', { must: true, trigger: t2 });
  assert.equal(state.sent.length, 0);
  assert.equal(state.pins.at(-1).emoji, '👍');
  // 4. Playing shows in its status.
  assert.ok(state.presence.some((a) => a?.kind === 'playing' && a.text === '五子棋'), JSON.stringify(state.presence));

  console.log('AI like a person: typing shown, no streaming in channels, paragraph messages, game turns never lost, reactions, stickers, mood, status');
} finally { await server.close(); }
