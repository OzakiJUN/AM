// Run with: npm test
import assert from 'node:assert/strict';
import { applyMention, matchPeople, mentionParts, mentionQuery, mentionedIds } from './mentions.ts';

assert.deepEqual(mentionQuery('你好 @小', 5), { start: 3, query: '小' });
assert.deepEqual(mentionQuery('@', 1), { start: 0, query: '' });
assert.equal(mentionQuery('mail@x', 6), null); // not after a space
assert.equal(mentionQuery('@小鱼 好', 5), null);
assert.deepEqual(applyMention('你好 @小 吗', 3, 5, '小鱼'), { text: '你好 @小鱼  吗', caret: 7 });
const picked = new Map([['1', '小鱼'], ['2', 'bob']]);
assert.deepEqual(mentionedIds('@小鱼 在吗', picked), ['1']);
const people = [{ id: '1', name: '小鱼', username: 'ai_x' }, { id: '2', name: 'Bob', username: 'bob' }, { id: '3', name: '大鱼', username: 'fish' }];
assert.deepEqual(matchPeople(people, '鱼').map((p) => p.id), ['1', '3']);
assert.deepEqual(matchPeople(people, 'b').map((p) => p.id), ['2']);
assert.equal(matchPeople(people, '').length, 3);
assert.deepEqual(mentionParts('嗨 @小鱼 和 @Bob！', ['小鱼', 'Bob']), [
  { text: '嗨 ' }, { text: '@小鱼', mention: true }, { text: ' 和 ' }, { text: '@Bob', mention: true }, { text: '！' },
]);
assert.deepEqual(mentionParts('没人', []), [{ text: '没人' }]);
console.log('mentions ok');
