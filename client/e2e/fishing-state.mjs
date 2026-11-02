// Exercise the real protobuf Session entrypoints; JSON int64 IDs remain strings.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({ server: { middlewareMode: true, hmr: false } });
try {
  const { Session } = await server.ssrLoadModule('/src/lib/session.ts');
  const { GAME_INFO, gameText } = await server.ssrLoadModule('/src/lib/games.ts');
  const s = Object.create(Session.prototype); const calls = [];
  s.call = async (method, path, schema, request) => {
    calls.push({ method, path, schema, request });
    return { stateJson: JSON.stringify(path.endsWith('rules') ? { version: 1, catalog: [{ id: 'f001' }] } : { coins: 12, room: '9007199254740993000', records: {}, cards: {}, badges: [0, 0, 0, 0, 0] }) };
  };
  assert.equal((await s.fishingRules()).catalog[0].id, 'f001');
  assert.equal((await s.fishingAccount()).room, '9007199254740993000');
  await s.fishingShowcase('9007199254740993001');
  await s.fishingAction({ action: 'buy_pack' }, 'stable-request-1');
  await s.fishingAction({ action: 'buy_pack' }, 'stable-request-1');
  assert.equal(calls[2].path, '/api/v1/users/9007199254740993001/fishing-showcase');
  assert.deepEqual(calls[3].request.value, calls[4].request.value);
  assert.equal(calls[3].request.value.requestId, 'stable-request-1');
  assert.equal(GAME_INFO.fishing.max, 12);
  const text = gameText({ id: '4', convId: '5', kind: 'fishing', status: 'playing', hostId: '9', players: [{ userId: '9' }], state: { pond: { now: 0, seats: [{ user_id: '9', bite_at: 0, expires_at: Date.now() + 10000 }] } }, waitingOn: [] }, '9', () => '小鱼');
  assert.match(text, /fishing_state/); assert.match(text, /12/); assert.match(text, /1号/);
  console.log('fishing Session endpoints, request ids and AI rule context ok');
} finally { await server.close(); }
