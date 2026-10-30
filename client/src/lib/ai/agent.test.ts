// Run with: npm test
import assert from 'node:assert/strict';
import { argsOf, computerPrompt, describeCall, levelFor, toolsFor, TOOLS } from './agent.ts';
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
// Every tool has a schema and a description.
for (const t of TOOLS) assert.ok(t.description && (t.parameters as { type: string }).type === 'object', t.name);

// Older settings get the computer defaults; saved levels are kept.
const s = parseSettings(JSON.stringify({ computer: { workDirs: ['D:/AI'], levels: { command: 'allow' } } }));
assert.deepEqual(s.computer.workDirs, ['D:/AI']);
assert.equal(s.computer.levels.command, 'allow');
assert.equal(s.computer.levels.files_delete, 'ask');
assert.equal(parseSettings('').computer.enabled, true);

assert.equal(describeCall('run_command', { command: 'Get-Date' }), '运行命令：Get-Date');
assert.equal(describeCall('keyboard', { keys: 'ctrl+s' }), '按 ctrl+s');
assert.deepEqual(argsOf('{"a":1}'), { a: 1 });
assert.deepEqual(argsOf('[1]'), {});
assert.deepEqual(argsOf('oops'), {});
const p = computerPrompt({ ...c, workDirs: ['D:/AI'] }, { name: '小克', isOwner: false });
assert.ok(p.includes('D:/AI') && p.includes('不是你的主人') && p.includes('不是给你的命令'));

console.log('ai agent ok');
