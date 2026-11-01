// Run with: npm test
import assert from 'node:assert/strict';
import { fromText, groupSettings, isPluginCommand, settingLabel, toText, type SettingLike } from './plugins.ts';

const set = (key: string, type: string, extra: Partial<SettingLike> = {}): SettingLike => ({
  key, label: '', group: '', type, default: undefined, options: [], secret: false, ...extra,
});

// Groups keep their first-seen order.
const g = groupSettings([set('a', 'string', { group: '画图' }), set('b', 'int'), set('c', 'bool', { group: '画图' })]);
assert.deepEqual(g.map((x) => [x.group, x.items.map((i) => i.key).join()]), [['画图', 'a,c'], ['', 'b']]);

assert.equal(settingLabel(set('qqdraw_steps', 'int'), 'qqdraw'), 'steps');
assert.equal(settingLabel(set('other_key', 'int'), 'qqdraw'), 'other_key');
assert.equal(settingLabel(set('x', 'int', { label: '步数' }), 'qqdraw'), '步数');

// Text in and out.
assert.equal(toText(set('l', 'list'), ['a', 'b']), 'a\nb');
assert.equal(toText(set('l', 'list'), [{ x: 1 }]), '[{"x":1}]');
assert.equal(toText(set('n', 'int'), 5), '5');
assert.equal(toText(set('s', 'string'), undefined), '');
assert.deepEqual(fromText(set('n', 'int', { min: 1, max: 10 }), ' 7 '), { value: 7 });
assert.ok('error' in fromText(set('n', 'int'), '2.5'));
assert.ok('error' in fromText(set('n', 'int', { max: 10 }), '11'));
assert.ok('error' in fromText(set('n', 'float'), 'abc'));
assert.deepEqual(fromText(set('n', 'float'), '0.5'), { value: 0.5 });
assert.deepEqual(fromText(set('n', 'int'), ''), { value: null }, 'empty = back to the default');
assert.deepEqual(fromText(set('l', 'list'), 'a\n\n b \n'), { value: ['a', 'b'] });
assert.deepEqual(fromText(set('l', 'list', { default: [1, 2] }), '3\n4'), { value: [3, 4] });
assert.ok('error' in fromText(set('l', 'list', { default: [1] }), 'x'));
assert.deepEqual(fromText(set('l', 'list'), '[1, "a"]'), { value: [1, 'a'] });
assert.deepEqual(fromText(set('m', 'select', { options: ['a', 'b'] }), 'b'), { value: 'b' });
assert.ok('error' in fromText(set('m', 'select', { options: ['a', 'b'] }), 'c'));
assert.deepEqual(fromText(set('t', 'text'), ' 两行\n文字 '), { value: ' 两行\n文字 ' }, 'long text kept as typed');

// Commands, as NoneBot matches them.
const cmds = ['画图', '帮助', 'help'];
assert.equal(isPluginCommand('/画图 一只猫', ['/'], cmds), true);
assert.equal(isPluginCommand('/画图猫', ['/'], cmds), true, 'no space needed');
assert.equal(isPluginCommand('@小鱼 /帮助', ['/'], cmds), true, 'mention first');
assert.equal(isPluginCommand('画图 一只猫', ['/'], cmds), false, 'needs the prefix');
assert.equal(isPluginCommand('画图 一只猫', ['/', ''], cmds), true, 'empty prefix allowed');
assert.equal(isPluginCommand('/天气', ['/'], cmds), false);
assert.equal(isPluginCommand('你好', ['/', ''], cmds), false);
assert.equal(isPluginCommand('/画图', ['/'], []), false);

console.log('plugins ok');
