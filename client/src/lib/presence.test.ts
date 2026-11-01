// Run with: npm test
import assert from 'node:assert/strict';
import { activityText, presenceText } from './presence.ts';

assert.equal(presenceText(undefined), '离线');
assert.equal(presenceText({}), '在线');
assert.equal(presenceText({ invisible: true }), '隐身中');
assert.equal(activityText({ kind: 'listening', text: '晴天' }), '🎧 正在听歌：晴天');
assert.equal(activityText({ kind: 'playing', text: '' }), '🎮 正在打游戏');
assert.equal(activityText({ kind: 'custom', text: '摸鱼中' }), '💬 摸鱼中');
assert.equal(presenceText({ invisible: true, activity: { kind: 'tuning_ai', text: '' } }), '🛠️ 正在调试 AI（隐身中）');
console.log('presence ok');
