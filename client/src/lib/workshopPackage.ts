// Workshop packages (a zip with manifest.json, format 1): unpacking and the
// same checks the am-workshop repository runs on pull requests
// (am-workshop/tools/workshop/format.go, FORMAT.md). Pure, unit-tested in
// workshopPackage.test.ts.
import { unzipSync } from 'fflate';
import type { WorkType } from './workshopIndex.ts';
import { MOODS, STATES } from './portraits.ts';

export interface Manifest {
  format: 1;
  type: WorkType;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  theme?: ThemePatch;
}

/** What a theme may set (the same fields as 设置 → 外观, lib/theme.ts). */
export interface ThemePatch {
  mode?: 'light' | 'dark' | 'system';
  accent?: string;
  /** File name of the background picture in the package. */
  background?: string;
  bgBlur?: number;
  bgDim?: number;
  fontScale?: number;
  glassStyle?: 'frosted' | 'clear' | 'tinted' | 'solid';
  glassOpacity?: number;
  glassBlur?: number;
}

export interface Persona {
  intro: string;
  system: string;
  examples: string;
  greeting: string;
}

export interface Package {
  manifest: Manifest;
  /** Every file but manifest.json, by name. */
  files: Record<string, Uint8Array>;
}

const MB = 1 << 20;
const MAX_FILE = 5 * MB;
const MAX_STICKER = 2 * MB;
const MAX_BACKGROUND = 3 * MB;
const MAX_STICKERS = 200;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const ID = /^[a-z0-9][a-z0-9-]{0,30}\.[a-z0-9][a-z0-9-]{0,30}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const len = (s: unknown) => (typeof s === 'string' ? [...s].length : 0);

export const PORTRAIT_KEYS: string[] = [...MOODS, ...STATES];

export class PackageError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.slice(0, 3).join('；') + (problems.length > 3 ? `……（共 ${problems.length} 个问题）` : ''));
    this.problems = problems;
  }
}

/** Unpacks and checks a package. `expect`: what the index says it is (omit for a file picked by hand). */
export function readPackage(zip: Uint8Array, maxMB: number, expect?: { id: string; type: WorkType; version: string; author: string }): Package {
  if (zip.length > maxMB * MB) throw new PackageError([`包太大了（最多 ${maxMB} MB）`]);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, { filter: (f) => !f.name.endsWith('/') && f.originalSize <= MAX_FILE });
  } catch {
    throw new PackageError(['不是 zip 文件，或者文件坏了']);
  }
  const errs: string[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (/[/\\]/.test(name) || name.startsWith('.') || len(name) > 100) {
      errs.push(`「${name}」：文件要放在 zip 最外层，不能有文件夹`);
      continue;
    }
    files[name] = data;
  }
  const raw = files['manifest.json'];
  if (!raw) throw new PackageError([...errs, 'zip 最外层没有 manifest.json（或者有文件超过 5 MB）']);
  delete files['manifest.json'];
  let m: Manifest;
  try {
    m = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
  } catch {
    throw new PackageError(['manifest.json 不是正确的 JSON']);
  }
  if (m.format !== 1) errs.push('manifest.json 的 format 不是 1（可能要更新 AM）');
  if (!['theme', 'portrait', 'persona', 'stickers'].includes(m.type)) errs.push(`不认识的类型「${String(m.type)}」`);
  if (!ID.test(String(m.id))) errs.push('id 不对');
  if (!VERSION.test(String(m.version))) errs.push('version 不对');
  if (!len(m.name) || len(m.name) > 30) errs.push('name 要写，最多 30 个字');
  if (len(m.description) > 500) errs.push('description 最多 500 个字');
  const perms = (m as unknown as { permissions?: unknown }).permissions;
  if (Array.isArray(perms) && perms.length) {
    errs.push('这个版本的 AM 还不能装要权限的作品');
  }
  if (expect && (m.id !== expect.id || m.type !== expect.type || m.version !== expect.version || String(m.author).toLowerCase() !== expect.author.toLowerCase())) {
    errs.push('包里写的和工坊列表里的对不上');
  }
  if (!errs.length) {
    if (m.type === 'theme') errs.push(...checkTheme(m.theme, files));
    if (m.type === 'portrait') errs.push(...checkPortrait(files));
    if (m.type === 'persona') errs.push(...checkPersona(files));
    if (m.type === 'stickers') errs.push(...checkStickers(files));
  }
  if (errs.length) throw new PackageError(errs);
  m.description = typeof m.description === 'string' ? m.description : '';
  return { manifest: m, files };
}

const RANGES: Record<string, [number, number]> = { bgBlur: [0, 30], bgDim: [0, 0.8], fontScale: [0.85, 1.25], glassOpacity: [0.2, 1], glassBlur: [0, 40] };

function checkTheme(t: ThemePatch | undefined, files: Record<string, Uint8Array>): string[] {
  if (!t || typeof t !== 'object' || !Object.keys(t).length) return ['主题里没有 theme 设置'];
  const errs: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (k === 'mode') { if (!['light', 'dark', 'system'].includes(v as string)) errs.push('theme.mode 不对'); }
    else if (k === 'accent') { if (!/^#[0-9a-fA-F]{6}$/.test(String(v))) errs.push('theme.accent 不对'); }
    else if (k === 'glassStyle') { if (!['frosted', 'clear', 'tinted', 'solid'].includes(v as string)) errs.push('theme.glassStyle 不对'); }
    else if (k === 'background') {
      const f = files[String(v)];
      if (!f || !IMAGE.test(String(v))) errs.push('theme.background 要是包里的一张图片');
      else if (f.length > MAX_BACKGROUND) errs.push('背景图最多 3 MB');
    } else if (RANGES[k]) {
      const [lo, hi] = RANGES[k];
      if (typeof v !== 'number' || v < lo || v > hi) errs.push(`theme.${k} 要在 ${lo} 到 ${hi} 之间`);
    } else errs.push(`theme 里没有「${k}」这一项`);
  }
  for (const name of Object.keys(files)) if (name !== t.background) errs.push(`「${name}」没有用到`);
  return errs;
}

function checkPortrait(files: Record<string, Uint8Array>): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const name of Object.keys(files)) {
    const key = name.replace(/\.[^.]+$/, '');
    if (!IMAGE.test(name) || !PORTRAIT_KEYS.includes(key)) errs.push(`「${name}」不是按情绪命名的图片`);
    else if (seen.has(key)) errs.push(`「${key}」有两张`);
    seen.add(key);
  }
  if (!seen.has('neutral')) errs.push('形象包没有 neutral（平静）');
  return errs;
}

function checkPersona(files: Record<string, Uint8Array>): string[] {
  const raw = files['persona.json'];
  if (!raw || Object.keys(files).length !== 1) return ['人格包里只能有 persona.json'];
  let p: Partial<Persona>;
  try {
    p = JSON.parse(new TextDecoder().decode(raw)) as Partial<Persona>;
  } catch {
    return ['persona.json 不是正确的 JSON'];
  }
  const errs: string[] = [];
  if (!len(p.system) || len(p.system) > 4000) errs.push('persona.json 的 system 要写，最多 4000 字');
  if (len(p.intro) > 100 || len(p.examples) > 2000 || len(p.greeting) > 200) errs.push('persona.json 有一项太长了');
  return errs;
}

function checkStickers(files: Record<string, Uint8Array>): string[] {
  const errs: string[] = [];
  let tags: Record<string, string[]> = {};
  if (files['tags.json']) {
    try {
      tags = JSON.parse(new TextDecoder().decode(files['tags.json'])) as Record<string, string[]>;
    } catch {
      errs.push('tags.json 不是正确的 JSON');
    }
  }
  let n = 0;
  for (const [name, data] of Object.entries(files)) {
    if (name === 'tags.json') continue;
    if (!IMAGE.test(name)) errs.push(`「${name}」不是图片`);
    else if (data.length > MAX_STICKER) errs.push(`「${name}」太大了（最多 2 MB）`);
    n++;
  }
  if (!n || n > MAX_STICKERS) errs.push(`表情包要有 1 到 ${MAX_STICKERS} 张图片`);
  for (const [name, t] of Object.entries(tags)) {
    if (!files[name]) errs.push(`tags.json 里的「${name}」不在包里`);
    if (!Array.isArray(t) || t.length > 10 || t.some((x) => len(x) > 20)) errs.push(`「${name}」的标签不对（最多 10 个，每个 20 字）`);
  }
  return errs;
}

// ---- reading the parts ----

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const mimeOf = (name: string) => MIME[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

export function personaOf(p: Package): Persona {
  const j = JSON.parse(new TextDecoder().decode(p.files['persona.json'])) as Partial<Persona>;
  return { intro: j.intro ?? '', system: j.system ?? '', examples: j.examples ?? '', greeting: j.greeting ?? '' };
}

/** Sticker pictures with their tags, in file-name order. */
export function stickersOf(p: Package): { name: string; data: Uint8Array; tags: string[] }[] {
  let tags: Record<string, string[]> = {};
  if (p.files['tags.json']) tags = JSON.parse(new TextDecoder().decode(p.files['tags.json'])) as Record<string, string[]>;
  return Object.keys(p.files).filter((n) => n !== 'tags.json').sort().map((name) => ({ name, data: p.files[name], tags: tags[name] ?? [] }));
}

/** Portrait pictures by emotion key. */
export function portraitsOf(p: Package): { key: string; name: string; data: Uint8Array }[] {
  return Object.keys(p.files).map((name) => ({ key: name.replace(/\.[^.]+$/, ''), name, data: p.files[name] }));
}
