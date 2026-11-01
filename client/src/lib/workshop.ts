// The creative workshop on this device (docs/design.md §13): what ships
// with the client, and what was installed from the workshop (GitHub index
// OzakiJUN/am-workshop, signed) or from a file (sideloaded, unreviewed).
// AIs learn every installed item ("plugins", lib/ai/memory.ts newPlugins):
// once when they first run, and again whenever something new is installed.
// Pure parts: lib/workshopIndex.ts, lib/workshopPackage.ts (tested).
import { create } from 'zustand';
import { TEMPLATES, type Persona } from './ai/persona';
import { GAME_INFO, KINDS, type GameKind } from './games';
import { inTauri } from './platform';
import { MOODS } from './portraits';
import { usePrefs } from './prefs';
import { useTheme } from './theme';
import {
  INDEX_SIG_URL, INDEX_URL, WORKSHOP_PUBLIC_KEY, compareVersions, newerOrSame, parseIndex, sha256Hex, verifySignature, viaMirror,
  type IndexItem, type WorkType,
} from './workshopIndex';
import { mimeOf, personaOf, portraitsOf, readPackage, stickersOf, type Package } from './workshopPackage';
import { deletePackage, loadPackage, savePackage } from './workshopStore';

export type WorkshopCategory = 'game' | 'portrait' | 'persona' | 'theme' | 'stickers' | 'widget';

export interface WorkshopItem {
  id: string;
  category: WorkshopCategory;
  name: string;
  /** One line for cards. */
  text: string;
  /** How to use it (detail dialog, and what AIs read). */
  detail: string;
  game?: GameKind;
  builtin: boolean;
  /** Installed from the workshop or a file (not built in). */
  installed?: InstalledMeta;
}

export const CATEGORY_NAME: Record<WorkshopCategory, string> = {
  game: '小游戏', portrait: 'AI 形象包', persona: '人格', theme: '主题', stickers: '表情包', widget: '主页组件',
};

const GAME_TEXT: Record<GameKind, string> = {
  gomoku: '两个人轮流下，先连五个的赢。AI 也会下（不算很强）。',
  reversi: '夹住就翻，最后子多的赢。和 AI 下正合适。',
  undercover: '4–8 个人（AI 也算）各拿一个词，轮流描述、投票找卧底。',
  trail: '2–6 个人各藏 3 个数，轮流提问、猜数，推理出别人的数。AI 也会推理。',
};

/** Everything that ships with the client (always installed, can't be removed). */
export const BUILT_IN: WorkshopItem[] = [
  ...KINDS.map((k): WorkshopItem => ({ id: `game:${k}`, category: 'game', name: GAME_INFO[k].name, text: GAME_TEXT[k], detail: GAME_INFO[k].rules, game: k, builtin: true })),
  {
    id: 'portrait:default', category: 'portrait', name: '默认立绘', builtin: true,
    text: `没有自己形象包的 AI 都用这套（${MOODS.length} 种情绪）`,
    detail: '给自己的 AI 换立绘：AI 设置 →「资料」→「立绘（形象包）」，按情绪命名的一组图片一次导入。',
  },
  ...TEMPLATES.map((t): WorkshopItem => ({
    id: `persona:${t.key}`, category: 'persona', name: t.name, text: t.persona.intro, builtin: true,
    detail: '新建 AI 时选它当起始人格，或者在 AI 设置 →「人格」里一键换成它。',
  })),
];

/** One installed work (the files are in IndexedDB, lib/workshopStore.ts). */
export interface InstalledMeta {
  id: string;
  type: WorkType;
  name: string;
  version: string;
  author: string;
  description: string;
  /** From the signed workshop index, or a file picked by hand (not reviewed). */
  source: 'workshop' | 'sideload';
  installedAt: number;
  /** Persona works: the persona itself (small, needed without waiting). */
  persona?: Persona;
  /** Taken down by the workshop since: the reason. */
  disabled?: string;
}

const HOW: Record<WorkType, string> = {
  theme: '在工坊「已安装」里点「套用」，就换成这个主题（设置 → 外观里还能再改）。',
  portrait: '给自己的 AI 用：AI 设置 →「资料」→「立绘」→「从工坊选」。',
  persona: '新建 AI 时选它当起始人格，或者在 AI 设置 →「人格」里一键换成它。',
  stickers: '在工坊「已安装」里点「导入到我的表情」，就加进当前服务器的「我的表情」。',
};

const toItem = (m: InstalledMeta): WorkshopItem => ({
  id: `ws:${m.id}`, category: m.type, name: m.name, builtin: false, installed: m,
  text: m.description.split('\n')[0].slice(0, 60) || `${m.author} 做的${CATEGORY_NAME[m.type]}`,
  detail: HOW[m.type],
});

const META_KEY = 'am-workshop-installed';
const INDEX_KEY = 'am-workshop-index';

function load<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full / blocked */
  }
}

interface CachedIndex {
  generatedAt: number;
  maxPackageMB: number;
  items: IndexItem[];
}

interface WorkshopState {
  /** Built-ins + installed works; AIs watch this to learn new ones. */
  installed: WorkshopItem[];
  metas: InstalledMeta[];
  /** Last verified index (kept for offline browsing), null = never loaded. */
  index: CachedIndex | null;
}

const initialMetas = load<InstalledMeta[]>(META_KEY, []);
export const useWorkshop = create<WorkshopState>(() => ({
  installed: [...BUILT_IN, ...initialMetas.map(toItem)],
  metas: initialMetas,
  index: load<CachedIndex | null>(INDEX_KEY, null),
}));

function setMetas(metas: InstalledMeta[]) {
  save(META_KEY, metas);
  useWorkshop.setState({ metas, installed: [...BUILT_IN, ...metas.map(toItem)] });
}

// ---- downloading ----

const devBase = !inTauri && __AM_DEV_WORKSHOP__ ? __AM_DEV_WORKSHOP__.replace(/\/+$/, '') : '';
const publicKey = devBase ? __AM_DEV_WORKSHOP_KEY__ : WORKSHOP_PUBLIC_KEY;

/** Whole file over HTTPS: through Rust in the desktop app (CA-checked), fetch in browser development. */
async function fetchBytes(url: string, max: number): Promise<Uint8Array> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return new Uint8Array(await invoke<ArrayBuffer>('web_get_bytes', { url, max }));
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > max) throw new Error('文件太大了');
  return b;
}

const mirrored = (url: string) => (devBase ? url : viaMirror(url, usePrefs.getState().workshopMirror));

/** The workshop is set up (a public key is built in), so the index can be trusted. */
export const workshopReady = () => !!publicKey;

/**
 * Downloads and checks the index (signature, not older than the last one),
 * keeps it, and marks installed works that were taken down.
 */
export async function refreshIndex(): Promise<CachedIndex> {
  if (!publicKey) throw new Error('工坊还没开通（还没设置签名密钥）');
  const [data, sig] = await Promise.all([
    fetchBytes(mirrored(devBase ? `${devBase}/index.json` : INDEX_URL), 8 << 20),
    fetchBytes(mirrored(devBase ? `${devBase}/index.sig` : INDEX_SIG_URL), 4096),
  ]);
  if (!(await verifySignature(data, new TextDecoder().decode(sig), publicKey))) {
    throw new Error('工坊列表的签名不对，可能被人改过（换个网络或镜像再试）');
  }
  const idx = parseIndex(data);
  const last = useWorkshop.getState().index;
  if (last && !newerOrSame(idx, last.generatedAt)) throw new Error('拿到的工坊列表比上次的还旧，没有用它（换个网络或镜像再试）');
  const cached: CachedIndex = { generatedAt: idx.generatedAt, maxPackageMB: idx.maxPackageMB, items: idx.items };
  save(INDEX_KEY, cached);
  useWorkshop.setState({ index: cached });
  // Taken down (or put back up) since.
  const byId = new Map(idx.items.map((x) => [x.id, x]));
  const metas = useWorkshop.getState().metas.map((m) => (m.source === 'workshop' ? { ...m, disabled: byId.get(m.id)?.disabled || undefined } : m));
  setMetas(metas);
  return cached;
}

/** What the installed copy of an index item is: not installed, installed, or an older version. */
export function installState(item: IndexItem): 'none' | 'installed' | 'update' {
  const m = useWorkshop.getState().metas.find((x) => x.id === item.id);
  if (!m) return 'none';
  return m.source === 'workshop' && compareVersions(item.version, m.version) > 0 ? 'update' : 'installed';
}

function remember(p: Package, source: InstalledMeta['source']) {
  const m = p.manifest;
  const meta: InstalledMeta = {
    id: m.id, type: m.type, name: m.name, version: m.version, author: m.author, description: m.description,
    source, installedAt: Date.now(), persona: m.type === 'persona' ? personaOf(p) : undefined,
  };
  setMetas([meta, ...useWorkshop.getState().metas.filter((x) => x.id !== m.id)]);
  return meta;
}

/** Downloads a work from the index, checks it and installs it (or updates it). */
export async function install(item: IndexItem): Promise<InstalledMeta> {
  if (item.disabled) throw new Error(`这个作品已经下架了：${item.disabled}`);
  const maxMB = useWorkshop.getState().index?.maxPackageMB ?? 20;
  const zip = await fetchBytes(mirrored(item.url), maxMB << 20);
  if ((await sha256Hex(zip)) !== item.sha256) throw new Error('下载到的文件和工坊登记的不一样（可能被人改过），没有安装');
  const p = readPackage(zip, maxMB, item);
  await savePackage(item.id, p);
  return remember(p, 'workshop');
}

/** Installs a package file picked by hand (not reviewed: the caller warns first). */
export async function installFile(file: File): Promise<InstalledMeta> {
  const p = readPackage(new Uint8Array(await file.arrayBuffer()), 20);
  await savePackage(p.manifest.id, p);
  return remember(p, 'sideload');
}

export async function uninstall(id: string) {
  await deletePackage(id);
  setMetas(useWorkshop.getState().metas.filter((x) => x.id !== id));
}

async function pkg(id: string): Promise<Package> {
  const p = await loadPackage(id);
  if (!p) throw new Error('这个作品的文件不见了，删掉重新安装一下');
  return p;
}

function usable(id: string) {
  const m = useWorkshop.getState().metas.find((x) => x.id === id);
  if (m?.disabled) throw new Error(`这个作品已经下架了：${m.disabled}`);
}

// ---- using what is installed ----

function dataUrl(bytes: Uint8Array, mime: string): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Applies a theme: the fields it sets replace mine (设置 → 外观 shows the result). */
export async function applyTheme(id: string) {
  usable(id);
  const p = await pkg(id);
  const t = p.manifest.theme ?? {};
  const { background, ...rest } = t;
  useTheme.getState().set({ ...rest, ...(background ? { background: dataUrl(p.files[background], mimeOf(background)) } : {}) });
}

const asFile = (name: string, data: Uint8Array) => new File([data.slice()], name, { type: mimeOf(name) });

/** A portrait pack's pictures as files named by emotion (for the AI pack editor). */
export async function portraitFiles(id: string): Promise<File[]> {
  usable(id);
  return portraitsOf(await pkg(id)).map((x) => asFile(x.name, x.data));
}

/** A sticker pack's pictures with their tags. */
export async function stickerFiles(id: string): Promise<{ file: File; tags: string[] }[]> {
  usable(id);
  return stickersOf(await pkg(id)).map((x) => ({ file: asFile(x.name, x.data), tags: x.tags }));
}

/** Persona templates: built-in ones and installed persona works. */
export function personaTemplates(metas: InstalledMeta[]): { key: string; name: string; persona: Persona }[] {
  return [
    ...TEMPLATES,
    ...metas.filter((m) => m.type === 'persona' && m.persona && !m.disabled).map((m) => ({ key: `ws:${m.id}`, name: m.name, persona: m.persona! })),
  ];
}

const previews = new Map<string, Promise<string>>();
/** A work's preview picture as a local URL (downloaded once; same rules as packages). */
export function previewUrl(url: string): Promise<string> {
  let p = previews.get(url);
  if (!p) {
    p = fetchBytes(mirrored(url), 2 << 20).then((b) => URL.createObjectURL(new Blob([b.slice()], { type: mimeOf(url) })));
    p.catch(() => previews.delete(url));
    previews.set(url, p);
  }
  return p;
}
