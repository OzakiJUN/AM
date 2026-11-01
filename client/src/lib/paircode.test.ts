// Run with: npm test
import assert from 'node:assert/strict';
import { base32Encode } from './joincode.ts';
import { encodePairCode, findPairCode, hex, newKey, pairUrl, parsePairCode, seal, unhex, unseal } from './paircode.ts';

const key = unhex('00112233445566778899aabbccddeeff');
const pin = unhex('0102030405060708090a0b0c0d0e0f10');
// Like the server's: 16 random bytes in the join-code alphabet (26 characters).
const ticket = base32Encode(unhex('f0e1d2c3b4a5968778695a4b3c2d1e0f'));
assert.equal(ticket.length, 26);

for (const server of [
  { address: '47.1.2.3:7000', plain: false, pin },
  { address: '127.0.0.1:8443', plain: true },
  { address: 'am.example.com:443', plain: false },
]) {
  const code = await encodePairCode({ server, ticket, key });
  assert.match(code, /^AMP-[A-Z2-9]{4}(-[A-Z2-9]{1,4})+$/);
  const p = await parsePairCode(code);
  assert.equal(p.server.address, server.address);
  assert.equal(p.server.plain, server.plain);
  assert.equal(p.server.pin ? hex(p.server.pin) : undefined, server.pin ? hex(server.pin) : undefined);
  assert.equal(p.ticket, ticket);
  assert.equal(hex(p.key), hex(key));
  // Found inside a QR link or a chat message, any case, with or without dashes.
  assert.equal(findPairCode(pairUrl('https://x.example/dl#old', code)), code);
  assert.equal(findPairCode('登录码：' + code.toLowerCase() + ' 五分钟内有效'), code);
  assert.equal((await parsePairCode(code.replace(/-/g, ''))).ticket, ticket);
}

// A changed character is caught by the check bytes.
const good = await encodePairCode({ server: { address: '127.0.0.1:8443', plain: true }, ticket, key });
const i = good.length - 8;
const bad = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
await assert.rejects(parsePairCode(bad));
await assert.rejects(parsePairCode('AM1-AAAA-BBBB'));

// Sealed data opens only with its key.
const k = newKey();
const box = await seal({ hello: '你好', n: 1 }, k);
assert.deepEqual(await unseal(box, k), { hello: '你好', n: 1 });
await assert.rejects(unseal(box, newKey()));
box[20] ^= 1;
await assert.rejects(unseal(box, k));

console.log('paircode ok');
