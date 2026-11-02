// Exercise the real Session history loader without a browser or a network.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true, hmr: false } });
try {
  const { Session } = await server.ssrLoadModule('/src/lib/session.ts');
  const session = Object.create(Session.prototype);
  const afters = [];
  session.olderBefore = new Map();
  session.struckIds = new Set();
  session.onChange = () => {};
  session.view = { me: { id: '3' }, messages: { 1: [{ id: '151', seq: 151, body: { kind: 'text', text: 'newest' } }] }, pins: {}, hasOlder: { 1: true }, convs: { 1: { lastSeq: 151, readSeq: 151 } } };
  session.request = async (request) => {
    const after = Number(request.value.cursors[0].afterSeq);
    afters.push(after);
    const events = Array.from({ length: 50 }, (_, i) => ({ convId: 1n, seq: BigInt(after + i + 1), eventId: BigInt(after + i + 1), senderId: 2n, createdAt: 1n, body: { case: 'emojiPin', value: { targetEventId: 1n, emoji: '😂', x: 0.5, y: 10, removePinId: 0n } } }));
    return { msg: { case: 'sync', value: { events } } };
  };
  await session.loadOlder('1');
  await session.loadOlder('1');
  await session.loadOlder('1');
  assert.deepEqual(afters, [100, 50, 0]);
  assert.equal(session.view.hasOlder['1'], false);
  assert.equal(session.view.messages['1'].length, 1);
  console.log('history pages advance through emoji-only events');
} finally { await server.close(); }
