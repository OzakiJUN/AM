// Run with: npm test
import assert from 'node:assert/strict';
import { EVOLVE_KEEP, adoptPersona, appPrompt, elsewherePrompt, defaultSettings, evolvePrompt, parseEvolved, parseSettings, previewText, systemPrompt, toChat, TEMPLATES } from './persona.ts';

// Settings survive missing / unknown fields.
assert.equal(parseSettings('').contextSize, 30);
const s = parseSettings(JSON.stringify({ model: 'deepseek-chat', persona: { greeting: '喵' } }));
assert.equal(s.model, 'deepseek-chat');
assert.equal(s.persona.greeting, '喵');
assert.equal(s.persona.system, defaultSettings().persona.system);
assert.equal(parseSettings('{oops').whoCanChat, 'owner');

const p = systemPrompt({ name: '小鱼', owner: 'Weiqi', persona: TEMPLATES[1].persona, now: new Date(2026, 9, 30, 8, 0) });
assert.ok(p.includes('小鱼') && p.includes('Weiqi') && p.includes('[mood:xxx]') && p.includes('happy'));

// Turns alternate, start with the user, group speakers are named.
assert.deepEqual(toChat([
  { fromAI: true, who: '小鱼', text: '你好' },
  { fromAI: false, who: 'A', text: '在吗' },
  { fromAI: false, who: 'A', text: '问个事' },
  { fromAI: true, who: '小鱼', text: '在' },
], false), [{ role: 'user', content: '在吗\n问个事' }, { role: 'assistant', content: '在' }]);
assert.deepEqual(toChat([{ fromAI: false, who: '小克', text: '嗨' }], true), [{ role: 'user', content: '小克：嗨' }]);

// Streaming preview hides the mood tag, even half-written.
assert.equal(previewText('[mood:ha'), '');
assert.equal(previewText('[mood:happy] 你好'), '你好');
assert.equal(previewText('没有标签'), '没有标签');
assert.equal(previewText('好呀 [mood:la'), '好呀');

// Growing its persona: small JSON answers only; bad / empty ones change nothing.
const old = TEMPLATES[0].persona;
assert.equal(parseEvolved('好的', old), null);
assert.equal(parseEvolved('{"system":""}', old), null);
assert.equal(parseEvolved(JSON.stringify({ intro: old.intro, system: old.system, examples: old.examples }), old), null);
const grown = parseEvolved('当然！{"intro":"会陪你打游戏的朋友","system":"' + old.system + '主人喜欢叫我小鱼干。","examples":""}', old)!;
assert.ok(grown.system.endsWith('小鱼干。') && grown.intro === '会陪你打游戏的朋友' && grown.examples === old.examples && grown.greeting === old.greeting);
let st = defaultSettings();
for (let i = 0; i < 12; i++) st = adoptPersona(st, { ...grown, intro: String(i) }, i);
assert.equal(st.personaHistory!.length, EVOLVE_KEEP);
assert.equal(st.evolvedAt, 11);
assert.equal(st.persona.intro, '11');
assert.ok(evolvePrompt({ name: '小鱼', owner: 'Weiqi', persona: old, lines: ['Weiqi：今天好累'] }).includes('Weiqi：今天好累'));
assert.deepEqual(parseSettings('{}').catchUp, { enabled: true, hours: 12, max: 5 });

// What it knows about AM comes from its tools; memory from elsewhere only when there is any.
const hp = appPrompt(['use_helper'], [], [{ name: '资讯', usage: '资讯 [关键词]', help: '马上查一次' }], '大管家');
assert.match(hp, /「大管家」.*use_helper/);
assert.match(hp, /· \/资讯 \[关键词\]：马上查一次/);
assert.doesNotMatch(appPrompt([], [], [{ name: '资讯', usage: '资讯', help: 'x' }]), /use_helper/, 'no tool, no list');
// Its browser: what it can do, which B站 account; hosted without one says why.
assert.match(appPrompt(['browser_search'], [], [], '小助手', { bili: '股肉-' }), /browser_search[\s\S]*「股肉-」/);
assert.match(appPrompt(['browser_search']), /没登录/);
assert.match(appPrompt([], [], [], '小助手', { hostedOff: true }), /服主没开/);
assert.doesNotMatch(appPrompt([]), /浏览器/);
const ap = appPrompt(['list_games', 'set_my_status'], [{ name: '五子棋', kind: '小游戏', detail: '连五个赢' }]);
assert.ok(ap.includes('· 五子棋（小游戏）：连五个赢') && ap.includes('open_game') && ap.includes('状态') && !ap.includes('个人主页'), ap);
assert.equal(elsewherePrompt([], []), '');
const ep = elsewherePrompt(['「大厅」Weiqi：我赢了'], ['和 Weiqi 下五子棋：Weiqi（黑）赢了']);
assert.ok(ep.includes('桌游：\n和 Weiqi') && ep.includes('最近的聊天：\n「大厅」'), ep);
console.log('ai persona ok');
