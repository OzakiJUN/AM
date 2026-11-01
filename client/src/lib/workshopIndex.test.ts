// Run with: npm test
import assert from 'node:assert/strict';
import { WORKSHOP_PUBLIC_KEY, compareVersions, newerOrSame, parseIndex, sha256Hex, verifySignature, viaMirror } from './workshopIndex.ts';

const enc = new TextEncoder();
const index = enc.encode(JSON.stringify({
  format: 1, generated_at: 5000, max_package_mb: 20,
  items: [
    { id: 'weiqi.sakura', type: 'theme', name: '樱花', author: 'OzakiJUN', repo: 'OzakiJUN/am-theme-sakura', version: '1.2.0',
      url: 'https://github.com/OzakiJUN/am-theme-sakura/releases/download/v1.2.0/s.zip', sha256: 'a'.repeat(64), size: 10, summary: '粉' },
    { id: 'x.game', type: 'game', name: '程序', sha256: 'b'.repeat(64) },
    { id: 'x.bad', type: 'theme', sha256: 'nope' },
  ],
}));

// Signature: made with a fresh key, checked with its public key; any change breaks it.
const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const pub = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))));
const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, index))));
assert.equal(await verifySignature(index, sig, pub), true);
const tampered = index.slice();
tampered[20] ^= 1;
assert.equal(await verifySignature(tampered, sig, pub), false);
assert.equal(await verifySignature(index, 'not base64!', pub), false);
assert.equal(await verifySignature(index, sig, ''), false, 'no key set: nothing is trusted');

// A signature made by the Go tool (am-workshop: ed25519.Sign with seed 7×32) checks out too.
const goPub = '6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=';
const goSig = 'mqPmjdloxO3nou5MCkDmfNa15ZkF84gpWEd8Xzv4IZXIxFeILDhKYJHmcJvE2yPMIgjgiwwrOj15Q7rjJF2GCA==';
assert.equal(await verifySignature(enc.encode('{"format":1}'), goSig, goPub), true, 'Go-signed vector');

// The real workshop key: the first index published by am-workshop's publish workflow checks out.
const realIndex = enc.encode("{\n \"format\": 1,\n \"generated_at\": 1793520369000,\n \"max_package_mb\": 20,\n \"items\": []\n}\n");
assert.equal(await verifySignature(realIndex, "j/wnbWbKi65KRsc57FrBA1gWA606+g46DCz5cJelNdxHqc8TEmn5jSB5fVhhmMvwWqczd73dEm6Q+q+6xnD3AQ=="), true, 'built-in key matches the published index');
assert.equal(await verifySignature(realIndex, "j/wnbWbKi65KRsc57FrBA1gWA606+g46DCz5cJelNdxHqc8TEmn5jSB5fVhhmMvwWqczd73dEm6Q+q+6xnD3AQ==", goPub), false);
assert.equal(WORKSHOP_PUBLIC_KEY.length, 44);

const idx = parseIndex(index);
assert.equal(idx.items.length, 1, 'unknown types and bad entries dropped');
assert.equal(idx.items[0].name, '樱花');
assert.equal(idx.generatedAt, 5000);
assert.ok(newerOrSame(idx, 5000) && !newerOrSame(idx, 5001));

assert.equal(compareVersions('1.10.0', '1.2.9'), 1);
assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
assert.equal(compareVersions('0.9.9', '1.0.0'), -1);

assert.equal(viaMirror('https://github.com/a/b', ''), 'https://github.com/a/b');
assert.equal(viaMirror('https://github.com/a/b', 'https://ghproxy.example/'), 'https://ghproxy.example/https://github.com/a/b');
assert.equal(viaMirror('https://github.com/a/b', 'http://insecure'), 'https://github.com/a/b');

assert.equal(await sha256Hex(enc.encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
console.log('workshop index ok');
