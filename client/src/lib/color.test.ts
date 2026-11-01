// Run with: npm test
import assert from 'node:assert/strict';
import { hexToHsv, hsvToHex, normalizeHex, onColor, pushRecent, rgbToHex } from './color.ts';

assert.equal(normalizeHex('#3A8DDF'), '#3a8ddf');
assert.equal(normalizeHex('38d'), '#3388dd');
assert.equal(normalizeHex('#12345'), null);
assert.equal(normalizeHex('red'), null);
assert.equal(rgbToHex(58, 141, 223), '#3a8ddf');
// Round trips stay exact for every preset colour.
for (const c of ['#ee5b9a', '#8b6cf0', '#3a8ddf', '#1fae93', '#f28b30', '#2f4fa8', '#000000', '#ffffff', '#808080']) {
  assert.equal(hsvToHex(hexToHsv(c)), c, c);
}
const h = hexToHsv('#ff0000');
assert.deepEqual([Math.round(h.h), h.s, h.v], [0, 1, 1]);
assert.equal(Math.round(hexToHsv('#0000ff').h), 240);
assert.equal(onColor('#ffffff'), '#000000');
assert.equal(onColor('#2f4fa8'), '#ffffff');
assert.deepEqual(pushRecent(['#111111', '#222222'], '#222222'), ['#222222', '#111111']);
assert.equal(pushRecent([], 'nope').length, 0);
assert.equal(pushRecent(Array.from({ length: 8 }, (_, i) => `#00000${i}`), '#ffffff').length, 8);
console.log('color ok');
