// Run with: npm test
import assert from 'node:assert/strict';
import { BackStack } from './back.ts';

// A fake browser: history entries, back() delivers popstate later, and a
// manual task queue for the stack's scheduled syncs.
const entries: unknown[] = ['page'];
let pops = 0;
const tasks: (() => void)[] = [];
const h = { pushState: (d: unknown) => void entries.push(d), back: () => { entries.pop(); pops++; } };
const s = new BackStack(h, (f) => void tasks.push(f));
const settle = () => {
  for (let n = 0; n < 50 && (tasks.length || pops); n++) {
    while (tasks.length) tasks.shift()!();
    if (pops) { pops--; s.popped(); }
  }
};
const pressBack = () => { entries.pop(); s.popped(); settle(); };
const closed: string[] = [];

// Open a chat, then a dialog on top: one extra entry while anything is open.
const releaseChat = s.push(() => closed.push('chat'));
const releaseDialog = s.push(() => closed.push('dialog'));
settle();
assert.equal(entries.length, 2);
pressBack(); // closes the dialog, the entry comes back for the chat
assert.deepEqual(closed, ['dialog']);
releaseDialog(); // the dialog unmounts: already gone
settle();
assert.equal(entries.length, 2);
pressBack();
assert.deepEqual(closed, ['dialog', 'chat']);
releaseChat();
settle();
assert.equal(entries.length, 1);
assert.equal(s.size, 0);

// Closing with ✕ removes the entry when nothing else is open.
const releaseA = s.push(() => closed.push('a'));
settle();
assert.equal(entries.length, 2);
releaseA();
settle();
assert.equal(entries.length, 1);
assert.deepEqual(closed, ['dialog', 'chat']);

// ✕ on the newer of two: the entry stays, back closes the older one.
const r1 = s.push(() => closed.push('1'));
const r2 = s.push(() => closed.push('2'));
settle();
r2();
settle();
assert.equal(entries.length, 2);
pressBack();
assert.deepEqual(closed.slice(-1), ['1']);
r1();
settle();
assert.equal(entries.length, 1);

// React's dev double mount: open, release, open again in one go → one entry.
const ra = s.push(() => closed.push('x'));
ra();
const rb = s.push(() => closed.push('y'));
settle();
assert.equal(entries.length, 2);
pressBack();
assert.deepEqual(closed.slice(-1), ['y']);
rb();
settle();
assert.equal(entries.length, 1);

// Back at the root (nothing open) is left to the app / system.
pressBack();
assert.equal(s.size, 0);
console.log('back stack ok');
