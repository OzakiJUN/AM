// Pairing codes ("AMP-..."): log in another device of mine (docs/design.md
// §7, 多设备). Only clients make and read them:
//
//   version 1 | ticket (16 bytes) | key (16 bytes) | server part of a join code | check (2 bytes)
//
// The ticket (from POST /api/v1/pair) logs the new device in on that server;
// the key decrypts the bundle the server hands over with it. The server
// never sees the key. QR content: <download page>#pair=<code>.
import { base32Decode, base32Encode, concat, decodePayload, encodePayload, sha256, type Join } from './joincode.ts';

export interface Pair {
  server: Join;
  /** Server ticket (join-code alphabet, 26 characters). */
  ticket: string;
  key: Uint8Array;
}

export class PairCodeError extends Error {}

/** Finds a pairing code in arbitrary text (clipboard, QR content). */
export function findPairCode(text: string): string | null {
  const m = /pair=([A-Za-z0-9-]+)/.exec(text) ?? /AMP(?:-?[A-Za-z2-9]{4}){10,}(?:-?[A-Za-z2-9]{1,3})?(?![A-Za-z0-9])/i.exec(text);
  if (!m) return null;
  return (m[1] ?? m[0]).toUpperCase();
}

export async function encodePairCode(p: Pair): Promise<string> {
  const ticket = base32Decode(p.ticket.toUpperCase());
  if (!ticket || ticket.length !== 16 || p.key.length !== 16) throw new PairCodeError('bad ticket or key');
  const body = concat(new Uint8Array([1]), ticket, p.key, encodePayload({ ...p.server, invite: undefined }));
  const sum = await sha256(body);
  return 'AMP-' + base32Encode(concat(body, sum.slice(0, 2))).replace(/(.{4})(?=.)/g, '$1-');
}

export async function parsePairCode(input: string): Promise<Pair> {
  const found = findPairCode(input) ?? input;
  const s = found.toUpperCase().replace(/[-\s]/g, '');
  if (!s.startsWith('AMP')) throw new PairCodeError('这不是 AM 登录码（应该以 AMP- 开头）');
  const raw = base32Decode(s.slice(3));
  if (!raw || raw.length < 40) throw new PairCodeError('登录码不完整，请整段复制');
  const body = raw.slice(0, raw.length - 2);
  const sum = await sha256(body);
  if (sum[0] !== raw[raw.length - 2] || sum[1] !== raw[raw.length - 1]) throw new PairCodeError('登录码有误（可能抄错了），请整段复制');
  if (body[0] !== 1) throw new PairCodeError(`登录码版本 ${body[0]} 比客户端新，请更新客户端`);
  let server: Join;
  try {
    server = decodePayload(body.slice(33));
  } catch {
    throw new PairCodeError('登录码有误，请整段复制');
  }
  return { server, ticket: base32Encode(body.slice(1, 17)), key: body.slice(17, 33) };
}

/** QR content for a pairing code: download page + "#pair=". */
export function pairUrl(downloadUrl: string, code: string) {
  return (downloadUrl || 'https://github.com/OzakiJUN/AM/releases/latest').split('#')[0] + '#pair=' + code;
}

export function newKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Encrypts JSON with AES-128-GCM: iv (12 bytes) | ciphertext. */
export async function seal(value: unknown, key: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  return concat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, data)));
}

/** Reverses seal; throws when the key is wrong or the data was changed. */
export async function unseal<T>(data: Uint8Array, key: Uint8Array): Promise<T> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, k, data.slice(12));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
