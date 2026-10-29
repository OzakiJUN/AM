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
assert.deepEqual(splitMoodTag('[mood:typing] x'), { mood: 'neutral', text: '[mood:typing] x' });
console.log('portraits: all ok');
