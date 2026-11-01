// Run with: npm test
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { PackageError, personaOf, portraitsOf, readPackage, stickersOf } from './workshopPackage.ts';

const enc = new TextEncoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const manifest = (type: string, extra: object = {}) => enc.encode(JSON.stringify({ format: 1, type, id: 'weiqi.test', name: '测试', version: '1.0.0', author: 'OzakiJUN', ...extra }));
const zip = (files: Record<string, Uint8Array>) => zipSync(files);
const expect = (type: 'theme' | 'portrait' | 'persona' | 'stickers') => ({ id: 'weiqi.test', type, version: '1.0.0', author: 'ozakijun' });
const fails = (f: () => unknown, re: RegExp) => assert.throws(f, (e: unknown) => e instanceof PackageError && re.test(e.problems.join('|')));

// Good packages of every type.
const theme = readPackage(zip({ 'manifest.json': manifest('theme', { theme: { mode: 'dark', accent: '#ee5b9a', background: 'bg.png', bgDim: 0.3 } }), 'bg.png': png }), 20, expect('theme'));
assert.equal(theme.manifest.theme?.background, 'bg.png');
assert.ok(theme.files['bg.png'] && !theme.files['manifest.json']);
const portrait = readPackage(zip({ 'manifest.json': manifest('portrait'), 'neutral.png': png, 'happy.webp': png, 'typing.gif': png }), 20, expect('portrait'));
assert.deepEqual(portraitsOf(portrait).map((p) => p.key).sort(), ['happy', 'neutral', 'typing']);
const persona = readPackage(zip({ 'manifest.json': manifest('persona'), 'persona.json': enc.encode('{"system":"你是猫娘","greeting":"喵"}') }), 20, expect('persona'));
assert.equal(personaOf(persona).greeting, '喵');
const stickers = readPackage(zip({ 'manifest.json': manifest('stickers'), 'b.png': png, '狗头.png': png, 'tags.json': enc.encode('{"狗头.png":["狗头","doge"]}') }), 20);
assert.deepEqual(stickersOf(stickers).map((s) => [s.name, s.tags.length]), [['b.png', 0], ['狗头.png', 2]]);

// Bad ones.
fails(() => readPackage(enc.encode('nope'), 20), /不是 zip/);
fails(() => readPackage(zip({ 'a.png': png }), 20), /manifest/);
fails(() => readPackage(zip({ 'manifest.json': manifest('theme', { theme: { accent: 'red', fontScale: 3 } }), 'x.png': png }), 20), /accent.*\|.*fontScale|没有用到/);
fails(() => readPackage(zip({ 'manifest.json': manifest('portrait'), 'happy.png': png }), 20), /neutral/);
fails(() => readPackage(zip({ 'manifest.json': manifest('portrait'), 'neutral.png': png, 'readme.txt': png }), 20), /情绪/);
fails(() => readPackage(zip({ 'manifest.json': manifest('persona'), 'persona.json': enc.encode('{"system":""}') }), 20), /system/);
fails(() => readPackage(zip({ 'manifest.json': manifest('stickers', { permissions: ['net'] }), 'a.png': png }), 20), /权限/);
fails(() => readPackage(zip({ 'manifest.json': manifest('stickers'), 'dir/a.png': png }), 20), /文件夹|1 到/);
fails(() => readPackage(zip({ 'manifest.json': manifest('game') }), 20), /不认识的类型/);
// What the index says must match the package.
fails(() => readPackage(zip({ 'manifest.json': manifest('persona'), 'persona.json': enc.encode('{"system":"x"}') }), 20, { ...expect('persona'), version: '2.0.0' }), /对不上/);
// Too big.
fails(() => readPackage(new Uint8Array(2 * 1024 * 1024 + 1), 2), /太大/);
console.log('workshop package ok');
