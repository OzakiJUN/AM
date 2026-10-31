// Run with: npm test
import assert from 'node:assert/strict';
import { parseTags, searchStickers, tagsText } from './stickerTags.ts';

assert.deepEqual(parseTags('开心, 狗头 #doge、开心 DOGE'), ['开心', '狗头', 'doge']);
assert.deepEqual(parseTags('  '), []);
assert.equal(parseTags('a b c d e f g h i j k l').length, 10);
assert.equal(parseTags('长'.repeat(30))[0].length, 20);
assert.equal(tagsText(['开心', '狗头']), '开心、狗头');
const list = [{ id: 1, tags: ['开心', '狗头'] }, { id: 2, tags: ['难过'] }, { id: 3, tags: [] }];
assert.deepEqual(searchStickers(list, '').map((x) => x.id), [1, 2, 3]);
assert.deepEqual(searchStickers(list, '狗').map((x) => x.id), [1]);
assert.deepEqual(searchStickers(list, '开心 狗头').map((x) => x.id), [1]);
assert.deepEqual(searchStickers(list, '开心 难过').map((x) => x.id), []);
console.log('sticker tags ok');
