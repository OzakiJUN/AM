// Run with: npm test
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import {
  balanceText, buildPayload, costNote, defaultDraw, drawOptions, errorText, extractPngs, hasCJK, isFree, orientationOf,
  parseCommand, parseSubscription, pickRandom, promptProblem, referenceCanvas, sizeFor, splitSections, styleSpecs, tagsText, takeRaw, takeStrength,
} from './nai.ts';

// Commands: prefix, aliases, @-mention first, v5, not commands.
assert.deepEqual(parseCommand('/nai 银发女孩'), { kind: 'draw', v5: false, text: '银发女孩' });
assert.deepEqual(parseCommand('@小鱼 /nai5 猫耳'), { kind: 'draw', v5: true, text: '猫耳' });
assert.equal(parseCommand('/NAI5 x')!.v5, true);
assert.equal(parseCommand('/nai余额')!.kind, 'balance');
assert.equal(parseCommand('/角色参考 坐着')!.kind, 'charref');
assert.equal(parseCommand('/风格迁移 强度0.8 城市')!.kind, 'vibe');
assert.equal(parseCommand('/放大')!.kind, 'upscale');
assert.equal(parseCommand('/查画师 mika')!.text, 'mika');
assert.equal(parseCommand('nai 银发'), null, 'needs the prefix');
assert.equal(parseCommand('nai 银发', ['/', ''])!.kind, 'draw', 'empty prefix allowed');
assert.equal(parseCommand('/naive'), null, 'a longer word is not the command');
assert.equal(parseCommand('/画图 x'), null);

// Options: orientation, 精绘, *N (capped), 步数.
let o = drawOptions('横图 *4 精绘 银发 步数40');
assert.deepEqual([o.text, o.orientation, o.fine, o.n, o.steps], ['银发', 'landscape', true, 4, 40]);
o = drawOptions('*12 猫', 8);
assert.equal(o.n, 8);
assert.equal(o.notes.length, 1);
assert.equal(drawOptions('步数99 猫').steps, 50);
assert.equal(drawOptions('方图猫').orientation, 'square');

assert.deepEqual(takeStrength('强度0.8 城市'), { text: '城市', strength: 0.8 });
assert.deepEqual(takeStrength('强度5 城市').strength, 1);
assert.deepEqual(takeRaw('原样，1girl, solo'), { raw: true, text: '1girl, solo' });
assert.equal(takeRaw('1girl').raw, false);
assert.equal(hasCJK('1girl, 猫耳'), true);
assert.equal(hasCJK('1girl, {cat ears}'), false);

// ||a|b|| and sections.
assert.equal(pickRandom('a ||x|y|z|| b', () => 0.5), 'a y b');
const sec = splitSections('two girls, park\nchar1: red hair\nchar1 negative: hat\nchar2: blue hair\nNegative: rain', () => 0);
assert.equal(sec.sectioned, true);
assert.equal(sec.text, 'two girls, park');
assert.equal(sec.negative, 'rain');
assert.deepEqual(sec.chars, [['red hair', 'hat'], ['blue hair', '']]);
assert.deepEqual(splitSections('角色1：猫娘\n负面：雨').chars, [['猫娘', '']]);
assert.equal(splitSections('just text').sectioned, false);

// 画师 / 风格.
const st = styleSpecs('少女 画师:wlop/Mika_Pikazo 风格:厚涂, 夜晚');
assert.equal(st.tags, 'artist:wlop, artist:mika pikazo, impasto, painterly, oil painting (medium)');
assert.equal(st.text.includes('少女') && st.text.includes('夜晚') && !st.text.includes('画师'), true);
const st2 = styleSpecs('猫 风格:蒸汽波');
assert.equal(st2.text, '猫，画风：蒸汽波');
assert.equal(st2.notes.length, 1);

// Content rules: minors always; NSFW only where allowed; block words.
assert.match(promptProblem('loli', true), /未成年/);
assert.match(promptProblem('萝莉', true), /未成年/);
assert.equal(promptProblem('a minority report?', true), '', 'only whole words');
assert.match(promptProblem('nude girl', false), /NSFW/);
assert.equal(promptProblem('nude girl', true), '');
assert.match(promptProblem('画个狗', true, ['狗']), /屏蔽/);

// Sizes.
assert.deepEqual(sizeFor('portrait'), [832, 1216]);
assert.deepEqual(sizeFor('square', true), [1472, 1472]);
assert.equal(orientationOf(1920, 1080), 'landscape');
assert.equal(orientationOf(1000, 1000), 'square');
assert.deepEqual(referenceCanvas(600, 1000), [1024, 1536]);

// Payload: quality, negatives (minors always, NSFW unless allowed), auto nsfw, characters, img2img, references.
const s = defaultDraw();
let p = buildPayload({ prompt: '1girl, nude', model: s.model, nsfwAllowed: true }, s, () => 0.5);
assert.equal(p.input, `nsfw, 1girl, nude, ${s.quality}`);
assert.equal(p.action, 'generate');
assert.equal((p.parameters as { negative_prompt: string }).negative_prompt.includes('futa'), true);
assert.equal((p.parameters as { negative_prompt: string }).negative_prompt.includes('explicit'), false);
assert.equal(isFree(p), true);
p = buildPayload({ prompt: 'cat', model: s.v5Model, nsfwAllowed: false, chars: [['red hair', '']], n: 3, steps: 40, seed: 7 }, s);
const q = p.parameters as Record<string, unknown>;
assert.equal(p.input, `cat, ${s.qualityV5}`);
assert.equal((q.negative_prompt as string).includes('explicit'), true);
assert.equal(q.n_samples, 3);
assert.equal(q.seed, 7);
assert.equal((q.characterPrompts as unknown[]).length, 1);
assert.equal(isFree(p), false);
p = buildPayload({ prompt: 'cat', model: s.model, nsfwAllowed: false, image: { b64: 'AAA', width: 1216, height: 832 } }, s);
assert.equal(p.action, 'img2img');
assert.equal((p.parameters as { width: number }).width, 1216);
p = buildPayload({ prompt: 'cat', model: s.model, nsfwAllowed: false, references: ['R'], vibes: [['V', 0.6]] }, s);
assert.equal((p.parameters as Record<string, unknown>).reference_image_multiple, undefined, 'references replace vibes');
assert.deepEqual((p.parameters as Record<string, unknown>).director_reference_images, ['R']);

// Answers: zip of PNGs; a PNG inside a stream.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
assert.equal(extractPngs(zipSync({ 'image_0.png': png, 'image_1.png': png })).length, 2);
assert.deepEqual([...extractPngs(new Uint8Array([9, 9, ...png, 7]))[0]], [...png]);
assert.throws(() => extractPngs(new Uint8Array([1, 2, 3])));

const b = parseSubscription('{"tier":3,"expiresAt":1800000000,"trainingStepsLeft":{"fixedTrainingStepsLeft":100,"purchasedTrainingSteps":20},"usage":{"percent":80}}');
assert.deepEqual(b, { anlas: 120, tier: 3, expires: 1800000000, battery: 80 });
assert.match(balanceText(b), /Opus.*剩余 120 Anlas.*V5 额度 80%/);
assert.equal(parseSubscription('{"trainingStepsLeft":5}').anlas, 5);
assert.equal(costNote(100, 90, true), '剩余 90 Anlas（这次花了 10）');
assert.equal(costNote(100, 100, false), '剩余 100 Anlas');
assert.equal(costNote(null, null, false), '');
assert.match(errorText(401, ''), /token/);
assert.match(errorText(400, '{"message":"bad size"}'), /bad size/);
assert.match(tagsText('mika', false, ['{"tags":[{"tag":"artist:mika pikazo","count":900,"confidence":0.9},{"tag":"mika","count":50}]}']), /画师:mika pikazo（900 张，把握 90%）/);
assert.match(tagsText('zz', false, ['{"tags":[]}']), /不认识/);

console.log('nai ok');
