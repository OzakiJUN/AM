// Run with: npm test
import assert from 'node:assert/strict';
import { channelTurnIsDirected, addressed, dayPlan, decide, batchDelay, shouldJoin, discussionText, defaultChannels, defaultGames, defaultProactive, proactive, defaultRoutine, dueEvents, isAsleep, isSkip, minutesOf, splitStatusTag, wantsToJoin, type Said } from './social.ts';

const s = defaultChannels();
const me = 'ai';
const now = 10_000_000;
const msg = (senderId: string, ago: number, o: Partial<Said> = {}): Said => ({ senderId, time: now - ago, ai: false, toMe: false, ...o });

// Spoken to: always answer soon (also in mention-only mode), even over the unsolicited hourly limit.
assert.equal(decide({ now, s: { ...s, mode: 'mention' }, recent: [msg('bob', 0, { toMe: true })], me, mySends: [], random: 0.99, random2: 0 }).act, 'reply');
assert.equal(decide({ now, s, recent: [msg('bob', 0, { toMe: true })], me, mySends: Array(30).fill(now - 1000), random: 0, random2: 0 }).act, 'reply');
// Its own message last, or mention-only mode: quiet.
assert.equal(decide({ now, s, recent: [msg(me, 0)], me, mySends: [], random: 0, random2: 0 }).act, 'no');
assert.equal(decide({ now, s: { ...s, mode: 'mention' }, recent: [msg('bob', 0)], me, mySends: [], random: 0, random2: 0 }).act, 'no');
// A substantive human message can start a turn; speaking recently never boosts the chance.
const cold = [msg('bob', 5000), msg('carol', 0)];
const warm = [msg(me, 6000), msg('bob', 0)];
const decideWith = (recent: Said[], random = 0, mySends: number[] = []) =>
  decide({ now, s, recent, me, mySends, random, random2: 0 });
assert.equal(decideWith(cold, 0.14).act, 'maybe');
assert.equal(decideWith(warm, 0.99).act, 'maybe');
assert.ok(decideWith(warm, 0, [now - 6000]).delay >= 14000);
assert.equal(decideWith([msg('bot', 0, { ai: true })]).act, 'maybe');
assert.equal(decideWith([msg('bob', 0, { toMe: true })]).act, 'reply');
for (const text of ['收到！','😂','嗯嗯，好的','哈哈哈','OK']) assert.equal(discussionText(text), false);
for (const text of ['为什么？','我不同意这个结论','42']) assert.equal(discussionText(text), true);
// Asleep: no chatting by itself.
assert.equal(decide({ now, s, recent: warm, me, mySends: [], asleep: true, random: 0, random2: 0 }).act, 'no');
// Too many AI messages in a row: wait for a person.
const aiChain = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? me : 'other-ai', 6 - i, { ai: true }));
assert.equal(decide({ now, s, recent: aiChain, me, mySends: [], random: 0, random2: 0 }).act, 'no');

assert.ok(addressed('小鱼你好', [], 'ai', '小鱼'));
assert.ok(addressed('hi', ['ai'], 'ai', '小鱼'));
assert.ok(!addressed('@阿明 小鱼刚才说什么了？', ['bob'], 'ai', '小鱼'));
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
// Games: keen by default, nearly always for its owner's games, never when full, asleep or busy.
const gs = defaultGames();
const j = (o: Partial<Parameters<typeof wantsToJoin>[0]>) => wantsToJoin({ s: gs, free: 1, playing: 0, byOwner: false, manyPlayers: false, asleep: false, random: 0.5, random2: 0, ...o });
assert.equal(j({}), 4000);
assert.equal(j({ random: 0.7 }), null);
assert.equal(j({ random: 0.7, manyPlayers: true }), 4000);
assert.equal(j({ random: 0.99, byOwner: true }), 4000);
assert.equal(j({ free: 0 }), null);
assert.equal(j({ asleep: true }), null);
assert.equal(j({ playing: 1 }), null);
assert.equal(j({ s: { ...gs, join: false } }), null);
// Talking first: hello when the owner comes online, a topic after a quiet spell, not while asleep.
const H = 3_600_000;
const T = 100 * H;
const pr = (o: Partial<Parameters<typeof proactive>[0]>) => proactive({
  s: defaultProactive(), now: T, asleep: false, ownerOnline: true, wasOnline: true, lastGreet: 0, lastChat: T - 60_000, lastTopic: 0, activityChanged: false, random: 0.5, ...o,
});
assert.equal(pr({ wasOnline: false, lastChat: T - 2 * H }), 'greet');
assert.equal(pr({ wasOnline: false, lastChat: T - 2 * H, lastGreet: T - H }), null); // greeted an hour ago
assert.equal(pr({ wasOnline: false, lastChat: T - 2 * H, asleep: true }), null);
assert.equal(pr({ ownerOnline: false }), null);
assert.equal(pr({ activityChanged: true, lastChat: T - H, random: 0.2 }), 'activity');
assert.equal(pr({ lastChat: T - 4 * H, random: 0.05 }), 'topic');
assert.equal(pr({ lastChat: T - 4 * H, random: 0.5 }), null);
assert.equal(pr({ lastChat: T - 2 * H, random: 0.05 }), null); // not quiet long enough
assert.equal(pr({ lastChat: T - 4 * H, random: 0.05, s: { ...defaultProactive(), topics: false } }), null);
console.log('ai social ok');

assert.equal(batchDelay(0, 0, 5, 20, 0), 5000);
assert.equal(batchDelay(19000, 0, 5, 20, 0), 1000);
assert.equal(batchDelay(25000, 0, 5, 20, 30000), 5000);
assert.equal(shouldJoin('{"reply":true}'), true);
assert.equal(shouldJoin('{"reply":false}'), false);
assert.equal(shouldJoin('{"reply":"true"}'), false);
assert.equal(shouldJoin('oops'), false);

// Follow-up turns use the same person's recent address or the AI's quoted reply.
const follow = (recent: Said[], seconds = 300, room = false) => channelTurnIsDirected(recent, me, now, seconds, room);
const question = msg('bob', 0, { text: '具体怎么操作？' });
const answer = msg(me, 2000, { ai: true, replyToSender: 'bob' });
assert.ok(follow([msg('bob', 3000, { toMe: true }), question])); // while first answer is still pending
assert.ok(follow([answer, question]));
assert.ok(follow([msg('bob', 400000, { toMe: true }), answer, question])); // answer renews conversation
assert.ok(!follow([answer, { ...question, senderId: 'carol' }]));
assert.ok(!follow([answer, { ...question, toOthers: true }]));
assert.ok(!follow([answer, { ...question, ai: true }]));
assert.ok(!follow([answer, { ...question, text: '哈哈哈' }]));
assert.ok(!follow([answer, question], 0));
assert.ok(!follow([{ ...answer, time: now - 300001 }, question]));
assert.ok(follow([question], 0, true));
assert.ok(!follow([{ ...question, toOthers: true }], 300, true));
const continued = { ...question, toMe: follow([answer, question]) };
assert.equal(decide({ now, s: { ...s, mode: 'mention' }, recent: [answer, continued], me, mySends: Array(40).fill(now - 100), random: 0, random2: 0 }).act, 'reply');
assert.equal(decideWith([question], 0, Array(30).fill(now - 1000)).act, 'no');
assert.equal(decideWith([msg('other-ai', 0, { ai: true, toMe: true })], 0, Array(30).fill(now - 1000)).act, 'no');
