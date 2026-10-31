// Run with: npm test
import assert from 'node:assert/strict';
import { emptyState, merge, noteLocal, plan, prune, sameState, serverKey } from './deviceState.ts';

const A = { address: '1.1.1.1:8443', plain: false, pin: 'aa' };
const B = { address: '2.2.2.2:8443', plain: false, pin: 'bb' };
const B2 = { ...B, pin: 'cc' }; // B reinstalled: another server

// PC joins A and B; the phone (paired earlier) only knows A.
let pc = noteLocal(emptyState(), [{ endpoint: A, name: 'A' }, { endpoint: B, name: 'B' }], [], 10);
let phone = noteLocal(emptyState(), [{ endpoint: A, name: 'A' }], [], 5);
let m = merge(phone, pc);
assert.equal(Object.keys(m.servers).length, 2);
assert.deepEqual(plan(m, [A], []).offers.map((e) => e.name), ['B']);
assert.deepEqual(plan(m, [A], [serverKey(B)]).offers, []); // ignored on this device

// PC leaves B: the phone forgets it too.
pc = noteLocal(pc, [], [B], 20);
m = merge(m, pc);
assert.deepEqual(plan(m, [A, B], []).remove, [B]);
assert.deepEqual(plan(m, [A], []).offers, []);

// Joining B again later (on the phone) beats the old removal.
phone = noteLocal(m, [{ endpoint: B, name: 'B' }], [], 30);
m = merge(pc, phone);
assert.equal(m.servers[serverKey(B)].removed, undefined);
assert.deepEqual(plan(m, [A], []).offers.map((e) => e.name), ['B']);

// A reinstalled server (new certificate) is a different entry.
m = noteLocal(m, [{ endpoint: B2, name: 'B 新' }], [B], 40);
assert.equal(m.servers[serverKey(B)].removed, true);
assert.equal(m.servers[serverKey(B2)].name, 'B 新');

// Merge is order-independent and idempotent; same-time removal wins.
const x = noteLocal(emptyState(), [{ endpoint: A, name: 'A' }], [], 50);
const y = noteLocal(x, [], [A], 50);
assert.ok(sameState(merge(x, y), merge(y, x)));
assert.equal(merge(x, y).servers[serverKey(A)].removed, true);
assert.ok(sameState(merge(m, m), m));
assert.ok(!sameState(m, x));

// A server that moved to another relay address is the same entry (same pin).
const moved = noteLocal(noteLocal(emptyState(), [{ endpoint: A, name: 'A' }], [], 60), [{ endpoint: { ...A, address: '9.9.9.9:7000' }, name: 'A' }], [], 70);
assert.equal(Object.keys(moved.servers).length, 1);
assert.equal(moved.servers[serverKey(A)].endpoint.address, '9.9.9.9:7000');
assert.deepEqual(plan(moved, [A], []).offers, []); // not offered as a new server
assert.deepEqual(plan(moved, [A], []).remove, []);
// Servers without a pin are known by address.
assert.notEqual(serverKey({ address: 'a:1', plain: true }), serverKey({ address: 'b:1', plain: true }));

// Old tombstones are dropped.
assert.equal(Object.keys(prune(y, 50 + 181 * 86_400_000).servers).length, 0);
assert.equal(Object.keys(prune(y, 60).servers).length, 1);

// Provider lists (with keys) travel too: newest wins.
const withP = (at: number, name: string) => ({ ...emptyState(), providers: { at, list: [{ name }] } });
assert.deepEqual(merge(withP(1, 'old'), withP(2, 'new')).providers, { at: 2, list: [{ name: 'new' }] });
assert.deepEqual(merge(withP(3, 'mine'), emptyState()).providers?.at, 3);
assert.ok(!sameState(withP(1, 'a'), withP(2, 'a')));
assert.equal(prune(withP(5, 'x'), 10).providers?.at, 5);

console.log('deviceState ok');
