// Run with: npm test
import assert from 'node:assert/strict';
import { isPluginCommand } from './plugins.ts';

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
