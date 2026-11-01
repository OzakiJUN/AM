// The creative workshop's index (docs/design.md §13): a list of works kept
// in the GitHub repository OzakiJUN/am-workshop, signed with the workshop
// key (Ed25519). Pure: parsing, signature check, versions, mirrors.
// Unit-tested in workshopIndex.test.ts.

/** The workshop's public key (base64), from `am-server workshop-keygen` (Weiqi, 2026-11-01). The private key is only in am-workshop's GitHub Secret WORKSHOP_SIGNING_KEY. */
export const WORKSHOP_PUBLIC_KEY = 'tkZXsOreW8PwAA2HkJhukqfJaxD9FlmVQBkL5rItfjs=';

const RAW = 'https://raw.githubusercontent.com/OzakiJUN/am-workshop/index';
export const INDEX_URL = `${RAW}/index.json`;
export const INDEX_SIG_URL = `${RAW}/index.sig`;

export type WorkType = 'theme' | 'portrait' | 'persona' | 'stickers';
export const WORK_TYPES: WorkType[] = ['theme', 'portrait', 'persona', 'stickers'];

/** One work as the index lists it. */
export interface IndexItem {
  id: string;
  type: WorkType;
  name: string;
  author: string;
  repo: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  summary: string;
  preview?: string;
  /** Taken down by the workshop: the reason. */
  disabled?: string;
}

export interface WorkshopIndex {
  format: number;
  generatedAt: number;
  maxPackageMB: number;
  items: IndexItem[];
}

const b64 = (s: string) => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

/** Checks the index signature (Ed25519 over the exact bytes of index.json). */
export async function verifySignature(data: Uint8Array, sigText: string, publicKey = WORKSHOP_PUBLIC_KEY): Promise<boolean> {
  if (!publicKey) return false;
  try {
    const key = await crypto.subtle.importKey('raw', b64(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64(sigText), data as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Reads index.json (already verified); drops entries this client doesn't understand. */
export function parseIndex(data: Uint8Array): WorkshopIndex {
  const j = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
  if (j.format !== 1 || !Array.isArray(j.items)) throw new Error('工坊索引的格式不认识，请更新 AM');
  const items: IndexItem[] = [];
  for (const raw of j.items as Record<string, unknown>[]) {
    const type = raw.type as WorkType;
    if (!WORK_TYPES.includes(type) || typeof raw.id !== 'string' || !/^[0-9a-f]{64}$/.test(str(raw.sha256))) continue;
    items.push({
      id: raw.id, type, name: str(raw.name, 30), author: str(raw.author, 39), repo: str(raw.repo), version: str(raw.version, 20),
      url: str(raw.url, 500), sha256: str(raw.sha256), size: Number(raw.size) || 0, summary: str(raw.summary, 60),
      preview: str(raw.preview, 500) || undefined, disabled: str(raw.disabled) || undefined,
    });
  }
  return { format: 1, generatedAt: Number(j.generated_at) || 0, maxPackageMB: Number(j.max_package_mb) || 20, items };
}

/** Compares "1.2.10" with "1.10.0": -1, 0, 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * A download address through the mirror the user set (for when GitHub is
 * slow): "<mirror>/<original url>", the way GitHub proxies take it. '' = direct.
 */
export function viaMirror(url: string, mirror: string): string {
  const m = mirror.trim().replace(/\/+$/, '');
  if (!m || !/^https:\/\//.test(m)) return url;
  return `${m}/${url}`;
}

/** SHA-256 of bytes, lower-case hex. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Accepts a newly downloaded index only if it is not older than the one
 * seen before (someone replaying an old index can't bring back a work that
 * was taken down).
 */
export function newerOrSame(next: WorkshopIndex, lastSeen: number): boolean {
  return next.generatedAt >= lastSeen;
}
