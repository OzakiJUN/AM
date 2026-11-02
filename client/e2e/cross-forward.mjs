// Run the actual relay and Session entry points, including a lost final ACK.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { create } = require('@bufbuild/protobuf');
const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true, hmr: false } });
try {
  const { Session } = await server.ssrLoadModule('/src/lib/session.ts');
  const { forwardAcrossServers } = await server.ssrLoadModule('/src/lib/crossForward.ts');
  const { ForwardMsgSchema } = await server.ssrLoadModule('/src/gen/am/v1/event_pb.ts');
  const original = create(ForwardMsgSchema, { entries: [
    { sourceConvId: 1n, sourceEventId: 2n, senderId: 3n, senderName: 'Alice', sourceName: '原频道', sentAt: 100n, body: { case: 'image', value: { mediaId: 10n } } },
    { sourceConvId: 1n, sourceEventId: 4n, senderId: 3n, senderName: 'Alice', sourceName: '原频道', sentAt: 200n, sourceServer: 'earlier.example:443', imported: true, body: { case: 'image', value: { mediaId: 10n } } },
    { sourceConvId: 1n, sourceEventId: 5n, senderId: 3n, senderName: 'Alice', sourceName: '原频道', sentAt: 300n, body: { case: 'file', value: { mediaId: 11n, name: 'report.txt' } } },
  ] });
  const source = Object.create(Session.prototype);
  source.record = { id: 'source', endpoint: { address: 'source.example:443' } };
  let exports = 0, reads = 0, uploads = 0, sends = 0;
  source.call = async (method, path, schema, req) => {
    exports++;
    assert.equal(method, 'POST'); assert.equal(path, '/api/v1/conversations/1/forward-export');
    assert.deepEqual(req.value.eventIds, [2n, 4n, 5n]);
    return original;
  };
  source.t = { mediaBytes: async () => { reads++; return new Blob(['bytes']); } };
  const target = Object.create(Session.prototype);
  target.record = { id: 'target' };
  target.upload = async () => ({ id: BigInt(100 + ++uploads) });
  target.applyEvents = () => {};
  target.call = async (method, path, schema, request) => {
    sends++;
    assert.equal(method, 'POST'); assert.equal(path, '/api/v1/conversations/99/forward-import');
    assert.equal(request.value.clientMsgId, 'stable-transfer-id');
    const body = request.value.body.value;
    assert.equal(body.sourceServer, 'source.example:443');
    assert.equal(body.importedEntries[0].body.value.mediaId, 101n);
    assert.equal(body.importedEntries[1].body.value.mediaId, 101n);
    assert.equal(body.importedEntries[2].body.value.mediaId, 102n);
    assert.equal(body.importedEntries[0].sourceServer, 'source.example:443');
    assert.equal(body.importedEntries[1].sourceServer, 'earlier.example:443');
    assert.ok(body.importedEntries.every((entry) => entry.imported));
    if (sends === 1) throw new Error('lost acknowledgement');
    return { eventId: 1000n };
  };
  const transfer = { clientMsgId: 'stable-transfer-id', uploads: new Map() };
  const run = () => forwardAcrossServers(source, target, '1', '99', ['2', '4', '5'], transfer, () => {});
  await assert.rejects(run, /lost acknowledgement/);
  await run();
  assert.equal(exports, 1); assert.equal(reads, 2); assert.equal(uploads, 2); assert.equal(sends, 2);
  assert.equal(original.entries[0].body.value.mediaId, 10n);
  assert.equal(original.entries[0].sourceServer, '');
  console.log('cross-server relay preserves sources, remaps media and retries one final message');
} finally { await server.close(); }
