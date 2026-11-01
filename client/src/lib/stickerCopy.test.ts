// Run with: npm test
import assert from 'node:assert/strict';
import { copyKey, isFinal, planCopies, type CopySticker } from './stickerCopy.ts';

const st = (id: string, sha: string, priv = false): CopySticker => ({ id, mediaId: 'm' + id, sha256: sha, tags: [], private: priv });

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

console.log('stickerCopy ok');
