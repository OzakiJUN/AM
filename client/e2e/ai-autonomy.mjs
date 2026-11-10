// Run the real autonomous tool loop with fake model/browser/network boundaries.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const state = { requests: [], calls: [], sent: [], writes: [], browsed: [], step: 0 };
globalThis.__amAutonomy = state;
const savedStorage = globalThis.localStorage;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const server = await createServer({ server: { middlewareMode: true, hmr: false }, plugins: [{
  name: 'autonomy-boundaries', enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('/src/lib/ai/runner.ts')) return code.replace("from '../transport'", "from 'virtual:autonomy-transport'").replace("from './tools'", "from 'virtual:autonomy-tools'") + '\nexport const testRunner = { reply, onGame, runs };';
  },
  resolveId(id) { if (id.startsWith('virtual:autonomy-')) return '\0' + id; },
  load(id) {
    if (id === '\0virtual:autonomy-transport') return `
      export async function secretDelete(){};export async function secretGet(){return null};export async function secretSet(){};
      export async function aiRequest(url,headers,body,onChunk){
        const s=globalThis.__amAutonomy;s.requests.push(JSON.parse(body));s.onRequest?.();
        const n=s.step++;
        const delta=n===0?{reasoning_content:'private tool reasoning',tool_calls:[{index:0,id:'browse-1',function:{name:'browser_open',arguments:'{"url":"https://example.com/fish"}'}}]}
          :n===1&&s.postAfterBrowse?{tool_calls:[{index:0,id:'post-1',function:{name:'use_helper',arguments:'{"command":"/资讯 鱼","show":true}'}}]}
          :{content:'阅读了鱼类资料 https://example.com/fish?token=secret ，记住星星鱼适合夜间钓。'};
        onChunk('data: '+JSON.stringify({model:'reported-flash',choices:[{delta}]})+'\\n\\n');return 200;
      }`;
    if (id === '\0virtual:autonomy-tools') return `
      export async function loadMcpTools(){return {defs:[],map:new Map(),errors:[]}};export function stopMcp(){};export const biliLogin={status:async()=>({login:true,name:'股肉-'})};
      export async function execTool(name,args,ctx){globalThis.__amAutonomy.calls.push({name,args,background:!!ctx.background});return {text:'标题：鱼类\\n地址：https://example.com/fish?token=secret\\n可以操作的元素：\\n[1] link 下一页\\n页面文字（开头）：星星鱼适合夜间钓。'}};`;
  },
}] });
try {
  const { testRunner, useAI } = await server.ssrLoadModule('/src/lib/ai/runner.ts');
  const { defaultSettings } = await server.ssrLoadModule('/src/lib/ai/persona.ts');
  const { emptyMemory, parseMemory } = await server.ssrLoadModule('/src/lib/ai/memory.ts');
  const { useProviders } = await server.ssrLoadModule('/src/lib/ai/keys.ts');
  const settings = { ...defaultSettings(), model: 'deepseek-flash', providerId: 'p', thinking: true };
  useProviders.setState({ loaded: true, list: [{ id: 'p', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', key: 'fake' }] });
  const view = { status: 'online', convs: { '10': { id: '10', kind: 'dm', peerId: '1', members: [] } }, messages: { '10': [] }, replyTargets: {}, games: {}, users: { '1': { id: '1', type: 'human', name: '主人' } } };
  const run = { serverId: 'srv', ai: { user: { id: '2', name: '小鱼', ownerId: '1' } }, settings, busy: new Set(), again: new Set(), pending: new Map(), sends: new Map(), helper: { cmds: [], at: Date.now() }, memory: emptyMemory(), memoryAt: 0, memoryLoaded: true, memoryQueue: Promise.resolve(), s: {
    view, nameOf: id => id === '1' ? '主人' : '小鱼', sendText: async (...args) => state.sent.push(args), addBrowseLog: async (...args) => state.browsed.push(args),
    putClientState: async data => { state.writes.push(JSON.parse(new TextDecoder().decode(data))); return state.writes.length; },
  } };
  testRunner.runs.set('srv|2', run);
  await testRunner.reply(run, '10', { idle: true, silent: true, note: '按兴趣浏览并记住见闻，不发消息。' });
  assert.deepEqual(state.calls.map(c => c.name), ['browser_open']);
  assert.equal(state.calls[0].background, true, 'its own surfing uses the background browser');
  // Its owner sees where it went (its own time = no chat).
  assert.deepEqual(state.browsed, [['open', 'https://example.com/fish', '']]);
  assert.match(state.requests[0].system ?? state.requests[0].messages[0].content, /browser_search/, 'its prompt tells it about its browser');
  const offered = state.requests[0].tools.map(t => t.function.name);
  assert.ok(offered.includes('browser_read') && !offered.includes('message_owner') && !offered.includes('run_command'));
  assert.equal(state.requests[1].messages.find(m => m.tool_calls)?.reasoning_content, 'private tool reasoning');
  assert.equal(useAI.getState().models['srv|2'].reported, 'reported-flash');
  assert.equal(state.sent.length, 0);
  const saved = state.writes.at(-1);
  // Only its own summary is remembered (one event), address without the query.
  assert.equal(saved.events.length, 1);
  assert.ok(saved.events[0].text.includes('星星鱼') && saved.events[0].text.includes('https://example.com/fish') && saved.events[0].id.startsWith('leisure:'));
  assert.ok(!JSON.stringify(saved).includes('secret') && !JSON.stringify(saved).includes('private tool reasoning'));
  view.convs['20'] = { id: '20', kind: 'group', name: '棋社' };
  const game = { id: '30', kind: 'gomoku', convId: '20', status: 'ended', players: [{ userId: '2' }, { userId: '1' }], state: { winner: -1, result: 'draw' }, updatedAt: Date.now() };
  testRunner.onGame(run, game); await run.memoryQueue;
  assert.ok(state.writes.at(-1).events.some(e => e.id === 'game:30:ended'));
  run.memory = parseMemory(JSON.stringify(state.writes.at(-1)));
  const n = state.writes.length;
  testRunner.onGame(run, game); await run.memoryQueue;
  assert.equal(state.writes.length, n); assert.equal(state.sent.length, 0);
  run.settings = { ...settings, computer: { ...settings.computer, levels: { ...settings.computer.levels, browser: 'deny' } } };
  state.step = 0; const before = state.calls.length;
  await testRunner.reply(run, '10', { idle: true, silent: true, note: '自己找事做' });
  assert.equal(state.calls.length, before);
  assert.ok(!state.requests.at(-2).tools.some(t => t.function.name.startsWith('browser_')));
  // After reading a page in its free time, it can't post anything that round.
  run.settings = settings; state.step = 0; state.postAfterBrowse = true;
  const callsBefore = state.calls.length;
  await testRunner.reply(run, '10', { idle: true, silent: true, note: '浏览' });
  state.postAfterBrowse = false;
  assert.deepEqual(state.calls.slice(callsBefore).map(c => c.name), ['browser_open'], 'the post was not run');
  const toolMsgs = state.requests.at(-1).messages.filter(m => m.role === 'tool');
  assert.match(toolMsgs.at(-1).content, /这一轮看过网页，先不发消息/);
  assert.equal(state.sent.length, 0);
  // A delayed model result must not operate the browser after its runner stops.
  const before2 = state.calls.length;
  state.step = 0;
  state.onRequest = () => testRunner.runs.delete('srv|2');
  const writesBeforeStop = state.writes.length;
  await testRunner.reply(run, '10', { idle: true, silent: true, note: '浏览' });
  assert.equal(state.calls.length, before2);
  assert.equal(state.writes.length, writesBeforeStop);
  state.onRequest = undefined;
  testRunner.runs.clear();
  console.log('AI autonomy: real browsing loop in the background browser, private reasoning, only its own summary remembered, no posts after browsing, game-end dedupe and denied tools');
} finally {
  await server.close();
  if (savedStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = savedStorage;
  delete globalThis.__amAutonomy;
}
