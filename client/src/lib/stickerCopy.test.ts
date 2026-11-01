// Run with: npm test
import assert from 'node:assert/strict';
import { SETTLE_MS, copyKey, isFinal, planCopies, privacyFixes, waiting, type CopySticker } from './stickerCopy.ts';

const st = (id: string, sha: string, priv = false, createdAt = 0): CopySticker => ({ id, mediaId: 'm' + id, sha256: sha, tags: [], private: priv, createdAt });

// A has two, B has one of them (same file), C has none.
const lists = { A: [st('a2', 'y'), st('a1', 'x')], B: [st('b1', 'x')], C: [] as CopySticker[] };
const plan = planCopies(lists, new Set());
const desc = plan.map((t) => `${t.from}->${t.to}:${t.sticker.sha256}`);
assert.deepEqual(desc, ['A->B:y', 'A->C:x', 'A->C:y'], 'each file once per target, oldest first');

// Done ones are skipped; the other server's copy is used instead.
const plan2 = planCopies(lists, new Set([copyKey('A', 'a1', 'C')]));
assert.deepEqual(plan2.map((t) => `${t.from}->${t.to}:${t.sticker.sha256}`), ['A->B:y', 'A->C:y', 'B->C:x']);

// Nothing without a sha; nothing when all have everything.
assert.equal(planCopies({ A: [st('a', '')], B: [] }, new Set()).length, 0);
assert.equal(planCopies({ A: [st('a', 'x')], B: [st('b', 'x')] }, new Set()).length, 0);

assert.ok(isFinal('sticker_limit') && !isFinal('http_502') && !isFinal('rate_limited'));

// Just added: not copied yet (time to tag it or make it private), but a round is due.
const now = 10 * SETTLE_MS;
const fresh = { A: [st('a', 'x', false, now - 1000)], B: [] as CopySticker[] };
assert.equal(planCopies(fresh, new Set(), now).length, 0);
assert.ok(waiting(fresh, now));
assert.equal(planCopies(fresh, new Set(), now + SETTLE_MS).length, 1);

// Made private after it was copied: the copy goes private too; copies made by others are left alone.
const later = { A: [st('a', 'x', true)], B: [st('b', 'x'), st('b2', 'y')], C: [st('c', 'x')] };
assert.deepEqual(privacyFixes(later, new Set([copyKey('A', 'a', 'B')])), [{ to: 'B', stickerId: 'b' }]);
assert.deepEqual(privacyFixes(later, new Set()), []);

console.log('stickerCopy ok');
