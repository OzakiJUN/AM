// Run with: npm test
import assert from 'node:assert/strict';
import { addressed, dayPlan, decide, defaultChannels, defaultRoutine, dueEvents, isAsleep, isSkip, minutesOf, splitStatusTag, type Said } from './social.ts';

const s = defaultChannels();
const me = 'ai';
const now = 10_000_000;
const msg = (senderId: string, ago: number, o: Partial<Said> = {}): Said => ({ senderId, time: now - ago, ai: false, toMe: false, ...o });

// Spoken to: always answer soon (also in mention-only mode), unless over the hourly limit.
assert.equal(decide({ now, s: { ...s, mode: 'mention' }, recent: [msg('bob', 0, { toMe: true })], me, mySends: [], random: 0.99, random2: 0 }).act, 'reply');
assert.equal(decide({ now, s, recent: [msg('bob', 0, { toMe: true })], me, mySends: Array(30).fill(now - 1000), random: 0, random2: 0 }).act, 'no');
// Its own message last, or mention-only mode: quiet.
assert.equal(decide({ now, s, recent: [msg(me, 0)], me, mySends: [], random: 0, random2: 0 }).act, 'no');
assert.equal(decide({ now, s: { ...s, mode: 'mention' }, recent: [msg('bob', 0)], me, mySends: [], random: 0, random2: 0 }).act, 'no');
// Active: joins in sometimes; much more often once it is in the conversation.
const cold = [msg('bob', 5000), msg('carol', 0)];
assert.equal(decide({ now, s, recent: cold, me, mySends: [], random: 0.2, random2: 0 }).act, 'maybe');
assert.equal(decide({ now, s, recent: cold, me, mySends: [], random: 0.5, random2: 0 }).act, 'no');
const warm = [msg('bob', 9000), msg(me, 6000), msg('bob', 0)];
assert.equal(decide({ now, s, recent: warm, me, mySends: [now - 6000], random: 0.5, random2: 0 }).act, 'maybe');
// The gap is respected by waiting, not by dropping the turn.
const d = decide({ now, s, recent: warm, me, mySends: [now - 6000], random: 0, random2: 0 });
assert.ok(d.delay >= 14_000, String(d.delay));
// Asleep: no chatting by itself.
assert.equal(decide({ now, s, recent: warm, me, mySends: [], asleep: true, random: 0, random2: 0 }).act, 'no');
// Too many AI messages in a row: wait for a person.
const aiChain = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? me : 'other-ai', 6 - i, { ai: true }));
assert.equal(decide({ now, s, recent: aiChain, me, mySends: [], random: 0, random2: 0 }).act, 'no');

assert.ok(addressed('小鱼你好', [], 'ai', '小鱼'));
assert.ok(addressed('hi', ['ai'], 'ai', '小鱼'));
assert.ok(!addressed('鱼', [], 'ai', '小鱼'));
assert.ok(!addressed('a', [], 'ai', 'a')); // one-letter names would match everything

// Routine: same plan for the same day, jitter within bounds, sorted.
const r = defaultRoutine();
const p1 = dayPlan('2026-11-01', r, 'ai-1');
assert.deepEqual(p1, dayPlan('2026-11-01', r, 'ai-1'));
assert.deepEqual(p1.map((e) => e.key), ['wake', 'meal-0', 'play-0', 'meal-1', 'play-1', 'sleep']);
for (const e of p1) {
  const base = { wake: 480, 'meal-0': 720, 'play-0': 915, 'meal-1': 1110, 'play-1': 1245, sleep: 1410 }[e.key]!;
  assert.ok(Math.abs(e.at - base) <= 20, `${e.key} ${e.at}`);
}
assert.notDeepEqual(p1, dayPlan('2026-11-02', r, 'ai-1')); // another day, other times
assert.deepEqual(dayPlan('2026-11-01', { ...r, enabled: false }, 'x'), []);
assert.equal(minutesOf('7:05'), 425);
assert.equal(minutesOf('25:00'), null);
const wake = p1[0];
assert.deepEqual(dueEvents(p1, wake.at + 1, new Set()).map((e) => e.key), ['wake']);
assert.deepEqual(dueEvents(p1, wake.at + 1, new Set(['wake'])), []);
assert.deepEqual(dueEvents(p1, wake.at + 50, new Set()), []); // missed: skipped
assert.ok(isAsleep(r, 2 * 60) && isAsleep(r, 23 * 60 + 45) && !isAsleep(r, 12 * 60));
assert.ok(isAsleep({ ...r, sleep: '01:00', wake: '09:00' }, 60 + 5) && !isAsleep({ ...r, sleep: '01:00', wake: '09:00' }, 23 * 60));

assert.deepEqual(splitStatusTag('[status:在吃火锅] 好辣！'), { status: '在吃火锅', text: '好辣！' });
assert.deepEqual(splitStatusTag('晚安～【status：睡觉中】'), { status: '睡觉中', text: '晚安～' });
assert.deepEqual(splitStatusTag('没有'), { text: '没有' });
assert.ok(isSkip('[skip]') && isSkip(' skip ') && isSkip('[mood:neutral] [skip]'));
assert.ok(!isSkip('skip 这个我不知道'));
console.log('ai social ok');
