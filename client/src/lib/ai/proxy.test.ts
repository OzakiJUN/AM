// Run with: npm test
import assert from 'node:assert/strict';
import { looksBlocked, needsProxy, proxyFor, proxyServer } from './proxy.ts';

assert.equal(proxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
assert.equal(proxyServer(' socks5://localhost:1080/ '), 'socks5://localhost:1080');
assert.equal(proxyServer('https://proxy.example.com:443'), 'https://proxy.example.com:443');
assert.equal(proxyServer('[::1]:7890'), 'http://[::1]:7890');
for (const bad of ['', '7890', 'ftp://a:1', 'a:0', 'a:70000', 'a:1 --no-sandbox', 'a:1,b:2', 'a b:1']) assert.equal(proxyServer(bad), null, bad);

assert.ok(needsProxy('https://www.youtube.com/watch?v=x'));
assert.ok(needsProxy('https://youtu.be/x') && needsProxy('https://zh.wikipedia.org/wiki/A') && needsProxy('https://x.com/a'));
assert.ok(!needsProxy('https://www.bilibili.com/video/BV1') && !needsProxy('https://www.bing.com/search?q=a'));
assert.ok(!needsProxy('https://notyoutube.com/') && !needsProxy('https://box.com/') && !needsProxy('not a url'));

const yt = 'https://www.youtube.com/results?search_query=a';
const bili = 'https://search.bilibili.com/all?keyword=a';
const p = (mode: 'system' | 'off' | 'on' | 'auto', server = '127.0.0.1:7890') => ({ mode, server });
assert.equal(proxyFor(p('system'), yt), 'system');
assert.equal(proxyFor(p('off'), yt), 'direct');
assert.equal(proxyFor(p('on'), bili), 'http://127.0.0.1:7890');
assert.equal(proxyFor(p('on', 'nope'), bili), 'system');
// Auto: by site, the AI's own choice wins, other calls don't restart the browser.
assert.equal(proxyFor(p('auto'), yt), 'http://127.0.0.1:7890');
assert.equal(proxyFor(p('auto'), bili), 'direct');
assert.equal(proxyFor(p('auto'), bili, true), 'http://127.0.0.1:7890');
assert.equal(proxyFor(p('auto'), yt, false), 'direct');
assert.equal(proxyFor(p('auto')), null);
assert.equal(proxyFor(p('auto', ''), yt), 'system');

assert.ok(looksBlocked('打不开这个网址：net::ERR_CONNECTION_RESET'));
assert.ok(looksBlocked('浏览器没反应'));
assert.ok(!looksBlocked('打不开这个网址：net::ERR_PROXY_CONNECTION_FAILED') && !looksBlocked('只能打开 http:// 或 https:// 网址'));
console.log('ai proxy ok');
