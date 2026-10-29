// Join codes ("AM1-..."): server address + certificate pin + optional
// invite. Same format as internal/connectcode (see docs/protocol.md).

export interface Join {
  address: string; // host:port
  pin?: Uint8Array; // first 16 bytes of the certificate SHA-256
  plain: boolean; // server without TLS (local testing)
  invite?: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const enc = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function base32Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function xor(b: Uint8Array, salt: Uint8Array) {
  let stream = await sha256(concat(enc.encode('AM join code v1'), salt));
  for (let i = 0; i < b.length; i++) {
    if (i > 0 && i % stream.length === 0) stream = await sha256(stream);
    b[i] ^= stream[i % stream.length];
  }
}

/** Finds a join code in arbitrary text (clipboard, QR content, a pasted message). */
export function findJoinCode(text: string): string | null {
  const m = /join=([A-Za-z0-9-]+)/.exec(text) ?? /AM1(?:-?[A-Za-z2-9]{4}){6,}(?:-?[A-Za-z2-9]{1,3})?(?![A-Za-z0-9])/i.exec(text);
  if (!m) return null;
  return (m[1] ?? m[0]).toUpperCase();
}

export class JoinCodeError extends Error {}

/** Decodes a join code (bare code or text/URL containing one). */
export async function parseJoinCode(input: string): Promise<Join> {
  const found = findJoinCode(input) ?? input;
  const s = found.toUpperCase().replace(/[-\s]/g, '');
  if (!s.startsWith('AM1')) throw new JoinCodeError('这不是 AM 加入码（应该以 AM1- 开头）');
  const raw = base32Decode(s.slice(3));
  if (!raw || raw.length < 12) throw new JoinCodeError('加入码不完整，请整段复制');
  if (raw[0] !== 1) throw new JoinCodeError(`加入码版本 ${raw[0]} 比客户端新，请更新客户端`);
  const head = raw.slice(0, 3);
  const rest = raw.slice(3);
  await xor(rest, head.slice(1, 3));
  const payload = rest.slice(0, rest.length - 2);
  const check = rest.slice(rest.length - 2);
  const sum = await sha256(concat(head, payload));
  if (sum[0] !== check[0] || sum[1] !== check[1]) throw new JoinCodeError('加入码有误（可能抄错了），请整段复制');

  let p = 0;
  const need = (n: number) => {
    if (p + n > payload.length) throw new JoinCodeError('加入码有误，请整段复制');
    const out = payload.slice(p, p + n);
    p += n;
    return out;
  };
  const flags = need(1)[0];
  let host: string;
  switch ((flags >> 4) & 3) {
    case 0:
      host = Array.from(need(4)).join('.');
      break;
    case 1: {
      const b = need(16);
      const groups: string[] = [];
      for (let i = 0; i < 16; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
      host = groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
      break;
    }
    case 2:
      host = new TextDecoder().decode(need(need(1)[0]));
      break;
    default:
      throw new JoinCodeError('加入码有误，请整段复制');
  }
  const pb = need(2);
  const port = (pb[0] << 8) | pb[1];
  const join: Join = { address: host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`, plain: (flags & 1) !== 0 };
  if (flags & 2) join.pin = need(16);
  if (flags & 4) {
    const b = need(7);
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    let code = '';
    for (let i = 0; i < 10; i++) {
      code = ALPHABET[Number(v & 31n)] + code;
      v >>= 5n;
    }
    join.invite = code;
  }
  if (p !== payload.length) throw new JoinCodeError('加入码有误，请整段复制');
  return join;
}

function base32Encode(b: Uint8Array) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const x of b) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Builds a join code (same bytes as the Go encoder, so codes match). */
export async function encodeJoinCode(j: Join): Promise<string> {
  const m = /^\[?(.+?)\]?:(\d+)$/.exec(j.address);
  if (!m) throw new JoinCodeError('bad address');
  const [host, port] = [m[1], Number(m[2])];
  const body: number[] = [];
  let flags = (j.plain ? 1 : 0) | (j.pin ? 2 : 0) | (j.invite ? 4 : 0);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    body.push(...host.split('.').map(Number));
  } else if (host.includes(':')) {
    flags |= 1 << 4;
    const [a, b = ''] = host.split('::');
    const left = a ? a.split(':') : [];
    const right = b ? b.split(':') : [];
    const groups = host.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    for (const g of groups) {
      const v = parseInt(g || '0', 16);
      body.push(v >> 8, v & 255);
    }
  } else {
    flags |= 2 << 4;
    const name = enc.encode(host.toLowerCase());
    body.push(name.length, ...name);
  }
  body.push(port >> 8, port & 255);
  if (j.pin) body.push(...j.pin.slice(0, 16));
  if (j.invite) {
    let v = 0n;
    for (const ch of j.invite.toUpperCase()) v = (v << 5n) | BigInt(ALPHABET.indexOf(ch));
    const packed: number[] = [];
    for (let i = 0; i < 7; i++) {
      packed.unshift(Number(v & 255n));
      v >>= 8n;
    }
    body.push(...packed);
  }
  const plain = new Uint8Array([flags, ...body]);
  const salt = (await sha256(concat(enc.encode('AM join salt'), plain))).slice(0, 2);
  const head = new Uint8Array([1, salt[0], salt[1]]);
  const sum = await sha256(concat(head, plain));
  const rest = concat(plain, sum.slice(0, 2));
  await xor(rest, salt);
  const text = base32Encode(concat(head, rest));
  return 'AM1-' + text.replace(/(.{4})(?=.)/g, '$1-');
}

/** QR content for a join code: download page + "#join=". */
export function joinUrl(downloadUrl: string, code: string) {
  return (downloadUrl || 'https://github.com/OzakiJUN/AM/releases/latest').split('#')[0] + '#join=' + code;
}
