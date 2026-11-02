// The actual client migration coordinator, including a committed activation whose
// response was lost. Server validation and real two-database transfers are in Go e2e.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const values = new Map(); globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
const server = await createServer({ server: { middlewareMode: true, hmr: false } });
try {
 const { addServer } = await server.ssrLoadModule('/src/lib/store.ts');
 const { readFishingSave, withFishingSave } = await server.ssrLoadModule('/src/lib/fishingSync.ts');
 const now = Date.now; let ticks = now(); Date.now = () => ticks += 10;
 const people = ['one', 'two'].map((name, i) => { const s = addServer({ name, endpoint: { address: name, plain: true } }); s.view.me = { id: String(i + 1), type: 'human' }; s.view.status = 'online'; return s; });
 Date.now = now;
 // addServer ids depend on milliseconds; deterministic ids in two distinct calls.
 assert.notEqual(people[0], people[1]);
 const data = new Map(people.map((s, i) => [s, { version: 2, identity: `identity-${i}`, local_slot: `slot-${i}`, revision: i === 0 ? 1 : 0, frozen: false, coins: i === 0 ? 123.45 : 200, fish: [{ id: 'same-fish' }], transfer_id: '', transfer_to: '' }]));
 let loseAck = true;
 for (const s of people) {
  s.fishingRawAccount = async () => structuredClone(data.get(s));
  s.fishingSyncRequest = async (mode, json, revision, transfer, destination) => {
   const current = data.get(s);
   if (mode === 'activate' && !current.frozen && current.transfer_id === transfer) return { account: structuredClone(current) };
   assert.equal(current.revision, revision);
   if (mode === 'export') { Object.assign(current, { frozen: true, transfer_id: transfer, transfer_to: destination, revision: revision + 1 }); return { account: structuredClone(current), receipts: { paid: 'hash' } }; }
   const incoming = JSON.parse(json).account, slot = current.local_slot;
   if (mode === 'activate') assert.equal(incoming.transfer_to, slot);
   Object.assign(current, incoming, { local_slot: slot, frozen: mode !== 'activate', revision: incoming.revision + (mode === 'activate' ? 1 : 0) });
   if (mode === 'activate' && loseAck) { loseAck = false; throw new Error('lost activation acknowledgement'); }
   return { account: structuredClone(current) };
  };
 }
 const [a, b] = people;
 await readFishingSave(a); assert.equal(data.get(b).coins, 123.45); assert.equal(data.get(b).frozen, true);
 let purchases = 0;
 await assert.rejects(withFishingSave(b, async () => { purchases++; }), /lost activation/);
 assert.equal(purchases, 0);
 assert.ok(JSON.parse(values.get('am-fishing-save-v2')).pending);
 await withFishingSave(b, async () => { purchases++; data.get(b).coins = 123.30; data.get(b).revision++; });
 assert.equal(purchases, 1); assert.equal(data.get(a).frozen, true); assert.equal(data.get(b).frozen, false);
 assert.equal(data.get(a).coins, 123.30); assert.equal(data.get(b).fish[0].id, 'same-fish');
 b.view.status = 'offline';
 await assert.rejects(withFishingSave(a, async () => { throw new Error('must not act'); }), /未连接/);
 assert.equal((await readFishingSave(a)).coins, 123.30); // offline mirrors remain readable
 assert.equal(data.get(a).frozen, true);
 console.log('client fishing save: one active copy, replica ownership, ACK recovery and offline read-only copy ok');
} finally { await server.close(); delete globalThis.localStorage; }
