// Run with: npm test
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings, previewText, systemPrompt, toChat, TEMPLATES } from './persona.ts';

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

console.log('ai persona ok');
