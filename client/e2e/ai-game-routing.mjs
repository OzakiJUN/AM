// The real tool dispatcher must never send game requests to paid image generation.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false } });
try {
  const { execTool } = await server.ssrLoadModule('/src/lib/ai/tools.ts');
  const { defaultComputer } = await server.ssrLoadModule('/src/lib/ai/persona.ts');
  const calls = [];
  const ctx = { computer: defaultComputer(), scale: 1, mcp: new Map(), owner: 'routing-test', self: {
    game: async (name, args) => { calls.push({ route: 'game', name, args }); return 'game ok'; },
    draw: async (args) => { calls.push({ route: 'draw', args }); return 'draw ok'; },
    helper: async (args) => { calls.push({ route: 'helper', args }); return 'helper ok'; },
  } };
  const games = ['list_games', 'open_game', 'join_game', 'start_game', 'view_game', 'fishing_state', 'fishing_act', 'fishing_shop', 'game_move', 'game_say', 'game_vote', 'game_ask', 'game_guess', 'leave_game'];
  for (const name of games) {
    const args = { kind: 'fishing', game_id: '9007199254740993000', action: 'reel' };
    assert.deepEqual(await execTool(name, args, ctx), { text: 'game ok' });
    assert.deepEqual(calls.at(-1), { route: 'game', name, args });
    assert.deepEqual(await execTool(name, args, { ...ctx, self: undefined }), { text: '现在用不了这个工具' });
  }
  assert.equal(calls.length, games.length);
  assert.ok(calls.every(c => c.route === 'game'));
  assert.deepEqual(await execTool('draw_picture', { prompt: 'pond illustration' }, ctx), { text: 'draw ok' });
  assert.equal(calls.at(-1).route, 'draw');
  assert.deepEqual(await execTool('use_helper', { command: '帮助' }, ctx), { text: 'helper ok' });
  assert.equal(calls.at(-1).route, 'helper');
  console.log('AI game tools route only to games; drawing and helper stay independent');
} finally { await server.close(); }
