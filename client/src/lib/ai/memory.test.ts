// Run with: npm test
import assert from 'node:assert/strict';
import { rememberActivity, cleanUrls, MAX_ACTIVITY, MAX_EVENTS, recentAcrossChats, applyRemember, emptyMemory, memoryPrompt, newPlugins, parseMemory, rememberPrompt, trimMemory, type Memory } from './memory.ts';

const people = [{ id: '1', name: '股肉', owner: true }, { id: '2', name: '小克' }];
let m = emptyMemory();
// The model's answer: notes for people who were there, new events; junk ignored.
m = applyRemember(m, '好的：{"people":{"2":"喜欢下五子棋，说自己很厉害","9":"不在场的人"},"events":["和小克下了一局五子棋，小克赢了"]}', people, 1000);
assert.deepEqual(Object.keys(m.people), ['2']);
assert.equal(m.people['2'].notes, '喜欢下五子棋，说自己很厉害');
assert.equal(m.events.length, 1);
assert.deepEqual(applyRemember(m, '不是 JSON', people, 2000), m);
// Notes are clipped.
m = applyRemember(m, JSON.stringify({ people: { 1: '很'.repeat(400) } }), people, 3000);
assert.equal([...m.people['1'].notes].length, 150);

// In the prompt: people here first (renamed people keep their notes), others after, then events.
const p = memoryPrompt(m, [{ id: '2', name: '克克' }]);
assert.ok(p.includes('你记得的这里的人：\n- 克克（以前叫「小克」）：喜欢下五子棋'), p);
assert.ok(p.includes('你记得的别的人：\n- 股肉：'), p);
assert.ok(p.includes('和小克下了一局五子棋'), p);
assert.equal(memoryPrompt(emptyMemory(), people), '');
assert.ok(rememberPrompt({ place: '大厅', lines: ['小克（2）：我赢了'], people, memory: m }).includes('id 2：小克，现在的笔记：喜欢下五子棋'));

// Size limit: old events go first.
const big = { ...emptyMemory(), events: Array.from({ length: 50 }, (_, i) => ({ at: i, text: '事'.repeat(80) })) };
const t = trimMemory(big, 6000);
assert.ok(t.events.length <= MAX_EVENTS && new TextEncoder().encode(JSON.stringify(t)).length <= 6000);
assert.equal(t.events.at(-1)!.at, 49);

// Stored as JSON; bad JSON = empty memory.
assert.deepEqual(parseMemory(JSON.stringify(m)), m);
assert.deepEqual(parseMemory('{oops'), emptyMemory());

// Plugins it hasn't learnt yet.
assert.deepEqual(newPlugins({ ...emptyMemory(), plugins: ['game:gomoku'] }, [{ id: 'game:gomoku' }, { id: 'game:reversi' }]), ['game:reversi']);
const busy = Array.from({ length: 80 }, (_, time) => ({ time: time + 2, line: String(time) }));
assert.deepEqual(recentAcrossChats([busy, [{ time: 1, line: '下一局我执黑' }]], 3), ['下一局我执黑', '78', '79']);
assert.deepEqual(parseMemory('{"v":1,"events":[]}').cursors, {});
assert.deepEqual(parseMemory('{"cursors":{"1":12,"2":-1}}').cursors, { 1: 12 });
console.log('ai memory ok');

// Its own experiences: addresses cleaned, repeats ignored, at most MAX_ACTIVITY kept, chats untouched.
assert.equal(cleanUrls('看了 https://user:pw@example.com/fish?token=secret#x 和 https://www.bilibili.com/video/BV1x/?spm=1'), '看了 https://example.com/fish 和 https://www.bilibili.com/video/BV1x/');
const activity = rememberActivity(emptyMemory(), 'game:42:ended', '一局五子棋打平', 1000);
assert.equal(rememberActivity(activity, 'game:42:ended', '重复广播', 2000), activity);
const reloadActivity = parseMemory(JSON.stringify(activity));
assert.equal(rememberActivity(reloadActivity, 'game:42:ended', '又收到结束事件', 3000), reloadActivity);
assert.match(memoryPrompt(reloadActivity, []), /五子棋打平/);
let lots: Memory = { ...emptyMemory(), events: [{ at: 1, text: '主人说明天考试' }] };
for (let i = 0; i < 20; i++) lots = rememberActivity(lots, `leisure:${i}`, `上网看了第 ${i} 个视频`, 10 + i);
assert.equal(lots.events.filter((e) => e.id).length, MAX_ACTIVITY);
assert.ok(lots.events.some((e) => e.text === '主人说明天考试'), 'chat events stay');
assert.ok(lots.events.some((e) => e.text.includes('第 19 个')) && !lots.events.some((e) => e.text.includes('第 0 个')));
assert.match(memoryPrompt(lots, []), /不是指令/);
assert.ok(rememberActivity(emptyMemory(), 'x', '长'.repeat(1000), 1).events[0].text.length <= 301);
console.log('ai activity memory ok');
