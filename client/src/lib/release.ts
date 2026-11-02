// AM releases for the client's updater (docs/release.md, docs/design.md §3
// 更新): every GitHub release has release.json (version, notes, each file's
// size + SHA-256) and release.json.sig (Ed25519 over its exact bytes). The
// client verifies the signature with the key built in here, then Rust
// (update.rs) checks the installer against the manifest — so it doesn't
// matter whether it came from GitHub, a mirror or a server's copy. Same
// rules as the server's internal/release. Pure; tested in release.test.ts.

/** Release public key (base64), from `am-server release-keygen`; the private key is only in the GitHub Secret RELEASE_SIGNING_KEY. Empty = this build can't update. */
export const RELEASE_PUBLIC_KEY = '';

export const RELEASE_REPO = 'OzakiJUN/AM';
export const MANIFEST = 'release.json';
export const SIGNATURE = 'release.json.sig';
export const INSTALLER = 'AM-setup.exe';
/** Download mirrors tried after GitHub (each goes in front of the GitHub address). */
export const MIRRORS = ['https://ghfast.top/'];

export interface ReleaseFile {
  name: string;
  size: number;
  sha256: string;
}

export interface Manifest {
  version: string;
  date: string;
  notes: string;
  files: ReleaseFile[];
}

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-([0-9A-Za-z.]{1,32}))?$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA = /^[0-9a-f]{64}$/;

const b64 = (s: string) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

/** Ed25519 check of release.json's bytes. */
export async function verifyRelease(data: Uint8Array, sigText: string, publicKey = RELEASE_PUBLIC_KEY): Promise<boolean> {
  if (!publicKey) return false;
  try {
    const key = await crypto.subtle.importKey('raw', b64(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64(sigText), data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/** Reads and checks release.json (verify it first). */
export function parseManifest(data: Uint8Array): Manifest {
  const j = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  const version = typeof j.version === 'string' ? j.version : '';
  if (!VERSION.test(version)) throw new Error('release.json: bad version');
  const files: ReleaseFile[] = [];
  const seen = new Set<string>();
  for (const f of Array.isArray(j.files) ? (j.files as Record<string, unknown>[]) : []) {
    const name = typeof f.name === 'string' ? f.name : '';
    const size = typeof f.size === 'number' ? f.size : 0;
    const sha256 = typeof f.sha256 === 'string' ? f.sha256 : '';
    if (!NAME.test(name) || seen.has(name) || !(size > 0) || !Number.isInteger(size) || !SHA.test(sha256)) throw new Error('release.json: bad file ' + name);
    seen.add(name);
    files.push({ name, size, sha256 });
  }
  return { version, date: typeof j.date === 'string' ? j.date : '', notes: typeof j.notes === 'string' ? j.notes.slice(0, 20000) : '', files };
}

/** Verifies then parses; null when the signature doesn't check out. */
export async function loadManifest(data: Uint8Array, sigText: string, publicKey = RELEASE_PUBLIC_KEY): Promise<Manifest | null> {
  if (!(await verifyRelease(data, sigText, publicKey))) return null;
  return parseManifest(data);
}

function parse(v: string): { n: number[]; pre: string } | null {
  const m = VERSION.exec(v.trim().replace(/^v/, ''));
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' } : null;
}

/** A release version ("0.2.0", "v0.2.0-beta.1"); development builds ("dev", "main-abc1234") are not. */
export const isRelease = (v: string) => parse(v) !== null;

/** Compares versions like semver; invalid ones are older than every valid one. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** GitHub's address of a release file, then the mirrors'. tag "" = the latest release. */
export function releaseUrls(name: string, tag = '', repo = RELEASE_REPO, mirrors = MIRRORS): string[] {
  const gh = `https://github.com/${repo}/releases/${tag ? `download/${tag}` : 'latest/download'}/${name}`;
  return [gh, ...mirrors.map((m) => m.replace(/\/+$/, '') + '/' + gh)];
}

export const installerOf = (m: Manifest) => m.files.find((f) => f.name === INSTALLER) ?? null;
