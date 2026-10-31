// Run with: npm test
import assert from 'node:assert/strict';
import { packFromFiles, resolveMood, splitMoodTag } from './portraits.ts';

const pack = packFromFiles({ 'x/dafeiyu_neutral.png': 'n', 'dafeiyu_happy.webp': 'h', 'sad.png': 's', 'readme.txt': 'r' });
assert.deepEqual(pack, { neutral: 'n', happy: 'h', sad: 's' });
assert.deepEqual(resolveMood(pack, 'laugh'), { src: 'h', grey: false }); // laugh -> happy
assert.deepEqual(resolveMood(pack, 'cry'), { src: 's', grey: false }); // cry -> sad
assert.deepEqual(resolveMood(pack, 'speechless'), { src: 'n', grey: false }); // -> confused -> thinking -> neutral
assert.deepEqual(resolveMood(pack, 'offline'), { src: 'n', grey: true });
assert.deepEqual(splitMoodTag('[mood:Happy] 你好'), { mood: 'happy', text: '你好' });
// Not a model mood: dropped, the text stays clean.
assert.deepEqual(splitMoodTag('[mood:typing] x'), { mood: 'neutral', text: 'x' });
// What real models write: tag at the end, full-width brackets, synonyms, Chinese.
assert.deepEqual(splitMoodTag('好呀～ [mood:laugh]'), { mood: 'laugh', text: '好呀～' });
assert.deepEqual(splitMoodTag('【mood：开心】今天不错'), { mood: 'happy', text: '今天不错' });
assert.deepEqual(splitMoodTag('[mood: excited] 冲！'), { mood: 'happy', text: '冲！' });
assert.deepEqual(splitMoodTag('[心情:害羞]才没有'), { mood: 'shy', text: '才没有' });
assert.deepEqual(splitMoodTag('没有标签'), { mood: 'neutral', text: '没有标签' });
assert.deepEqual(splitMoodTag('[mood:sad] 唉\n第二行'), { mood: 'sad', text: '唉\n第二行' });
console.log('portraits: all ok');
