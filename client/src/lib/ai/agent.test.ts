// Run with: npm test
import assert from 'node:assert/strict';
import { argsOf, categoryOf, computerPrompt, describeCall, levelFor, mcpTool, mcpToolName, toolsFor, TOOLS } from './agent.ts';
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
assert.deepEqual(toolsFor({ ...c, enabled: false }), []);
assert.equal(levelFor({ ...c, enabled: false }, 'read_file'), 'deny');
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

console.log('ai agent ok');
