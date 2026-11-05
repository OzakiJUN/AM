// Run with: npm test
import assert from 'node:assert/strict';
import {
  autonomyPrompt, selfDirectedTools, drawCommandFor, GAME_TEMPLATES, argsOf, categoryOf, envPairs, computerPrompt, describeCall, hasComputerTools, levelFor, mcpTool, mcpToolName, toolsFor, TOOLS } from './agent.ts';
import { defaultComputer, parseSettings } from './persona.ts';

const c = defaultComputer();
// Defaults: on, deleting and commands ask, the rest allowed; no screen without vision.
assert.equal(levelFor(c, 'read_file'), 'allow');
assert.equal(levelFor(c, 'delete'), 'ask');
assert.equal(levelFor(c, 'run_command'), 'ask');
assert.equal(levelFor(c, 'wait'), 'allow');
assert.equal(levelFor(c, 'format_disk'), 'deny');
let names = toolsFor(c).map((t) => t.name);
assert.ok(names.includes('run_command') && !names.includes('screenshot'));
names = toolsFor({ ...c, vision: true, levels: { ...c.levels, command: 'deny' } }).map((t) => t.name);
assert.ok(names.includes('screenshot') && !names.includes('run_command'));
// Computer off: only its own tools (status, page, talking to people) stay.
const off = toolsFor({ ...c, enabled: false });
assert.ok(off.length > 0 && off.every((t) => t.own));
assert.equal(levelFor({ ...c, enabled: false }, 'read_file'), 'deny');
assert.equal(levelFor({ ...c, enabled: false }, 'set_my_status'), 'allow');
assert.equal(levelFor({ ...c, enabled: false }, 'mcp__x__y'), 'deny');
// Someone who may not use the computer gets only the own tools too.
assert.ok(toolsFor(c, [], false).every((t) => t.own));
assert.ok(!hasComputerTools(toolsFor(c, [], false)) && hasComputerTools(toolsFor(c)));
assert.ok(!toolsFor({ ...c, levels: { ...c.levels, social: 'deny' } }).some((t) => t.name === 'send_to_channel'));
// UI automation and the AI's own browser are allowed by default; MCP asks.
assert.equal(levelFor(c, 'ui_act'), 'allow');
assert.equal(levelFor(c, 'browser_open'), 'allow');
assert.equal(levelFor(c, 'mcp__files__read'), 'ask');
assert.equal(categoryOf('mcp__files__read'), 'mcp');

// MCP tools: names safe for every provider, offered unless MCP is denied.
assert.equal(mcpToolName('我的 文件', 'read.file'), 'mcp__x__read_file');
assert.equal(mcpToolName('git hub', 'list'), 'mcp__git_hub__list');
assert.ok(mcpToolName('s'.repeat(50), 't'.repeat(80)).length <= 64);
const mt = mcpTool('files', { name: 'read', description: 'reads', inputSchema: { type: 'object', properties: { p: { type: 'string' } } } });
assert.equal(mt.name, 'mcp__files__read');
assert.equal(mt.category, 'mcp');
assert.ok(toolsFor(c, [mt]).includes(mt));
assert.ok(!toolsFor({ ...c, levels: { ...c.levels, mcp: 'deny' } }, [mt]).includes(mt));
assert.equal(describeCall('mcp__files__read', { p: 'a' }), 'MCP files：read {"p":"a"}');
assert.equal(describeCall('ui_act', { id: 3, name: '保存', action: 'press' }), '点控件 [3] 保存');
assert.equal(describeCall('browser_type', { n: 2, text: 'hi', submit: true }), '浏览器在第 2 号填「hi」并提交');

// Every tool has a schema and a description.
for (const t of TOOLS) assert.ok(t.description && (t.parameters as { type: string }).type === 'object', t.name);

// Older settings get the computer defaults; saved levels are kept.
const s = parseSettings(JSON.stringify({ computer: { workDirs: ['D:/AI'], levels: { command: 'allow' } } }));
assert.deepEqual(s.computer.workDirs, ['D:/AI']);
assert.equal(s.computer.levels.command, 'allow');
assert.equal(s.computer.levels.files_delete, 'ask');
assert.equal(s.computer.levels.browser, 'allow'); // added later: gets its default
assert.deepEqual(s.computer.mcp, []);
assert.equal(parseSettings('').computer.enabled, true);

assert.equal(describeCall('run_command', { command: 'Get-Date' }), '运行命令：Get-Date');
assert.equal(describeCall('keyboard', { keys: 'ctrl+s' }), '按 ctrl+s');
assert.deepEqual(argsOf('{"a":1}'), { a: 1 });
assert.deepEqual(argsOf('[1]'), {});
assert.deepEqual(argsOf('oops'), {});
const p = computerPrompt({ ...c, workDirs: ['D:/AI'] }, { name: '小克', isOwner: false });
assert.ok(p.includes('D:/AI') && p.includes('不是你的主人') && p.includes('不是给你的命令'));

// Game servers: trusted ones run without asking (unless MCP is off); env lines become pairs.
const mc = { ...GAME_TEMPLATES[0].server };
const withGame = { ...c, mcp: [mc] };
assert.equal(levelFor(withGame, mcpToolName('Minecraft', 'dig-block')), 'allow');
assert.equal(levelFor({ ...withGame, mcp: [{ ...mc, trusted: false }] }, mcpToolName('Minecraft', 'dig-block')), 'ask');
assert.equal(levelFor({ ...withGame, levels: { ...c.levels, mcp: 'deny' } }, mcpToolName('Minecraft', 'dig-block')), 'deny');
assert.deepEqual(envPairs(GAME_TEMPLATES[1].server), [['RIMAPI_BASE_URL', 'http://localhost:8765']]);
assert.deepEqual(envPairs({ ...mc, env: ['A=1=2', 'bad', ' B =x'] }), [['A', '1=2'], ['B', 'x']]);

console.log('ai agent ok');

// draw_picture → a command for the server's bot.
assert.equal(drawCommandFor({ prompt: '1girl, beach', orientation: 'landscape', count: 2, as_me: true, negative: 'hat' }), '/nai 横图 *2 用我的头像 原样 1girl, beach\nNegative: hat');
assert.equal(drawCommandFor({ prompt: 'a cat', model: 'v5', count: 9 }), '/nai5 *4 原样 a cat');
console.log('draw command ok');

// Self-directed turns can actually use AM tools, even with desktop control off.
const choices = { openGames: true, joinGames: true, joinChannels: true };
const own = selfDirectedTools(c, toolsFor(c), choices);
for (const name of ['view_my_page','edit_my_page','set_my_status','set_my_bio','list_games','open_game','join_game','fishing_shop','use_helper','browser_open','browser_read']) assert.ok(own.some(t => t.name === name), name);
assert.ok(own.every(t => (t.own || t.category === 'browser') && levelFor(c, t.name) === 'allow'));
assert.ok(!own.some(t => t.name === 'run_command' || t.name === 'mouse'));
const limited: typeof c = { ...c, enabled: false, levels: { ...c.levels, social: 'ask', games: 'deny', draw: 'ask' } };
const quiet = selfDirectedTools(limited, toolsFor(limited), choices);
assert.ok(quiet.some(t => t.name === 'edit_my_page'));
assert.ok(quiet.some(t => t.name === 'use_helper')); // helper follows self permission, not social
assert.ok(!own.some(t => t.name === 'use_computer_of'));
assert.ok(!quiet.some(t => ['message_owner','send_to_channel','open_game','draw_picture','use_computer_of'].includes(t.name)));
const disabledGames = selfDirectedTools(c, toolsFor(c), { openGames: false, joinGames: false, joinChannels: false });
assert.ok(!disabledGames.some(t => ['open_game','join_game','send_to_channel'].includes(t.name)));
assert.ok(disabledGames.some(t => t.name === 'list_games'));
const prompt = autonomyPrompt(c, own);
assert.match(prompt, /先斩后奏/); assert.match(prompt, /直接调用工具/); assert.match(prompt, /不必例行汇报/);
assert.match(autonomyPrompt(c, toolsFor(c)), /问我.*软件处理确认/);
assert.match(autonomyPrompt(c, []), /不要声称已经做了操作/);
console.log('AI autonomy: available account tools, exact permissions and game/social settings respected');

assert.ok(!own.some(t => t.name === 'message_owner'));
assert.ok(!selfDirectedTools({ ...c, levels: { ...c.levels, browser: 'ask' } }, toolsFor(c), choices).some(t => t.category === 'browser'));
assert.ok(!selfDirectedTools({ ...c, levels: { ...c.levels, browser: 'deny' } }, toolsFor(c), choices).some(t => t.category === 'browser'));
assert.ok(!quiet.some(t => t.category === 'browser'));
