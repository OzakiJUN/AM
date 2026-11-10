// Run with: npm test
import assert from 'node:assert/strict';
import { hostedSettings, parseHostConfig } from './hostMode.ts';
import { defaultSettings } from './persona.ts';

const file = {
  version: 1, server: { address: '127.0.0.1:8443', plain: false, pin: 'ab'.repeat(32) }, aiId: '42', token: 't0k',
  providers: [{ id: 'p1', kind: 'openai', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', key: 'sk-1' }], workDir: 'D:\\am\\data\\hosting\\ai-42\\work',
  dataDir: 'D:\\am\\data\\hosting\\ai-42\\webview',
};
const cfg = parseHostConfig(JSON.stringify(file));
assert.ok(cfg);
assert.equal(cfg.aiId, '42');
assert.equal(cfg.providers[0].key, 'sk-1');
assert.equal(cfg.server.pin, 'ab'.repeat(32));
assert.equal(parseHostConfig(JSON.stringify({ ...file, version: 2 })), null, 'unknown version');
assert.equal(parseHostConfig(JSON.stringify({ ...file, token: '' })), null);
assert.equal(parseHostConfig('not json'), null);
assert.equal(parseHostConfig(null), null);
assert.equal(parseHostConfig(JSON.stringify({ ...file, server: { address: '127.0.0.1:1', plain: true, pin: '' } }))!.server.pin, undefined);

// Only its own folder; nothing that touches the server's computer; ask = no.
const s = defaultSettings();
s.computer.enabled = false;
s.computer.workDirs = ['C:\\Users\\weiqi'];
s.computer.levels.social = 'ask';
s.computer.mcp = [{ name: 'mc', command: 'x', args: [], enabled: true } as never];
const h = hostedSettings(s, cfg.workDir);
assert.equal(h.computer.enabled, true);
assert.deepEqual(h.computer.workDirs, [cfg.workDir]);
assert.equal(h.computer.mcp.length, 0);
for (const c of ['command', 'open', 'clipboard', 'screen', 'input', 'ui', 'browser', 'mcp'] as const) assert.equal(h.computer.levels[c], 'deny', c);
assert.equal(cfg.browser, false, 'no browser unless the server says so');
for (const c of ['files_read', 'files_write', 'files_delete'] as const) assert.equal(h.computer.levels[c], 'allow', c);
assert.equal(h.computer.levels.social, 'deny', 'nobody can answer an ask');
assert.equal(h.computer.levels.self, 'allow');
assert.equal(s.computer.workDirs[0], 'C:\\Users\\weiqi', 'the saved settings are untouched');

// The server allows a browser: the owner's level stays (ask = no), the rest as before.
assert.equal(parseHostConfig(JSON.stringify({ ...file, browser: true }))!.browser, true);
const b = hostedSettings(s, cfg.workDir, true);
assert.equal(b.computer.levels.browser, 'allow');
assert.equal(b.computer.levels.screen, 'deny');
s.computer.levels.browser = 'ask';
assert.equal(hostedSettings(s, cfg.workDir, true).computer.levels.browser, 'deny', 'nobody can answer an ask');
s.computer.levels.browser = 'deny';
assert.equal(hostedSettings(s, cfg.workDir, true).computer.levels.browser, 'deny', 'the owner said no');

console.log('host mode ok');
