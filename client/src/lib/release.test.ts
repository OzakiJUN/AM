// Run with: npm test
import assert from 'node:assert/strict';
import { compareVersions, installerOf, isRelease, loadManifest, parseManifest, releaseUrls } from './release.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const sha = (c: string) => c.repeat(64);

const manifest = (v: string) =>
  enc(JSON.stringify({ version: v, date: '2026-11-02', notes: '- 自动更新', files: [{ name: 'AM-setup.exe', size: 3, sha256: sha('a') }] }));

// Signed with a fresh key: accepted with it, refused with another key or changed bytes.
const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
const pub = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
const data = manifest('0.2.0');
const sig = b64(await crypto.subtle.sign('Ed25519', keys.privateKey, data));
const m = await loadManifest(data, sig + '\n', pub);
assert.equal(m?.version, '0.2.0');
assert.equal(installerOf(m!)?.size, 3);
assert.equal(await loadManifest(manifest('0.2.1'), sig, pub), null, 'changed manifest');
const other = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
assert.equal(await loadManifest(data, sig, b64(await crypto.subtle.exportKey('raw', other.publicKey))), null, 'other key');
assert.equal(await loadManifest(data, 'xx', pub), null, 'garbage signature');
assert.equal(await loadManifest(data, sig, ''), null, 'no key built in');

// Bad manifests.
for (const bad of [
  { version: 'v0.2.0', files: [] },
  { version: 'latest', files: [] },
  { version: '0.2.0', files: [{ name: '../x', size: 1, sha256: sha('a') }] },
  { version: '0.2.0', files: [{ name: 'x', size: 0, sha256: sha('a') }] },
  { version: '0.2.0', files: [{ name: 'x', size: 1, sha256: 'ABC' }] },
  { version: '0.2.0', files: [{ name: 'x', size: 1, sha256: sha('a') }, { name: 'x', size: 1, sha256: sha('a') }] },
]) {
  assert.throws(() => parseManifest(enc(JSON.stringify(bad))), JSON.stringify(bad));
}

// Versions (same table as internal/release).
assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
assert.equal(compareVersions('v0.2.0', '0.2.0'), 0);
assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
assert.equal(compareVersions('dev', '0.0.1'), -1);
assert.equal(compareVersions('main-abc1234', 'dev'), 0);
assert.equal(isRelease('dev'), false);
assert.equal(isRelease('v1.2.3'), true);

// Where to download.
assert.deepEqual(releaseUrls('release.json', '', 'o/am', ['https://ghfast.top/']), [
  'https://github.com/o/am/releases/latest/download/release.json',
  'https://ghfast.top/https://github.com/o/am/releases/latest/download/release.json',
]);
assert.equal(releaseUrls('AM-setup.exe', 'v0.2.0', 'o/am', [])[0], 'https://github.com/o/am/releases/download/v0.2.0/AM-setup.exe');

console.log('release ok');
