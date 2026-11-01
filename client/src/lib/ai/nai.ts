// NovelAI drawing as an AI's own ability (docs/design.md §9 画画), ported
// from Weiqi's qqdraw NovelAI part: reading `/nai` commands, building the
// request, reading the answer, content rules. Pure, unit-tested
// (nai.test.ts); lib/ai/naiRun.ts does the network and pictures.
import { unzipSync } from 'fflate';

export const IMAGE_URL = 'https://image.novelai.net/ai/generate-image';
export const VIBE_URL = 'https://image.novelai.net/ai/encode-vibe';
export const UPSCALE_URL = 'https://image.novelai.net/ai/upscale';
export const SUB_URL = 'https://image.novelai.net/user/subscription';
export const SUGGEST_URL = 'https://image.novelai.net/ai/generate-image/suggest-tags';

export type Orientation = 'portrait' | 'landscape' | 'square';
export const SIZES: Record<Orientation, [number, number]> = { portrait: [832, 1216], landscape: [1216, 832], square: [1024, 1024] };
/** 精绘: large sizes (cost Anlas). */
export const LARGE_SIZES: Record<Orientation, [number, number]> = { portrait: [1024, 1536], landscape: [1536, 1024], square: [1472, 1472] };
export const MAX_PIXELS = 3047424;
export const MAX_STEPS = 50;
export const TIERS: Record<number, string> = { 0: '未订阅', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' };

/** The owner's drawing settings (AISettings.draw). */
export interface DrawSettings {
  /** The NovelAI entry in my providers (its key is the API token). '' = drawing is off. */
  providerId: string;
  /** http(s) proxy for NovelAI ('' = direct). */
  proxy: string;
  /** Who may use the /nai commands: only the owner, or everyone who can talk to it. */
  who: 'owner' | 'everyone';
  /** Pictures a day per person other than the owner (0 = no limit). */
  dailyPerPerson: number;
  /** Adult content in DMs with it (channels: the channel's NSFW switch). */
  nsfwInDM: boolean;
  maxCount: number;
  steps: number;
  scale: number;
  sampler: string;
  /** img2img strength, vibe strength, character reference strength / fidelity. */
  strength: number;
  vibeStrength: number;
  refStrength: number;
  refFidelity: number;
  model: string;
  v5Model: string;
  /** V5 takes Chinese as it is (no translation). */
  v5Native: boolean;
  quality: string;
  qualityV5: string;
  negative: string;
  /** Words that are never drawn (also added to the negative prompt when English). */
  blockWords: string[];
  /** Add "nsfw" when adult words are in the prompt and adult content is allowed. */
  autoNsfw: boolean;
}

export const defaultDraw = (): DrawSettings => ({
  providerId: '', proxy: '', who: 'owner', dailyPerPerson: 20, nsfwInDM: false, maxCount: 8, steps: 28, scale: 5,
  sampler: 'k_euler_ancestral', strength: 0.6, vibeStrength: 0.6, refStrength: 1, refFidelity: 1,
  model: 'nai-diffusion-4-5-full', v5Model: 'nai-diffusion-5-full', v5Native: true,
  quality: 'very aesthetic, masterpiece, no text', qualityV5: 'very aesthetic, masterpiece, no text, high complexity',
  negative: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, bad anatomy, bad proportions, bad hands, wrong hand, wrong fingers, extra digits, fewer digits, extra fingers, missing fingers, fused fingers, too many fingers, malformed hands, mutated hands, deformed hands, extra arms, extra hands, extra legs, missing limb, bad feet, extra toes',
  blockWords: [], autoNsfw: true,
});

/** Preset styles for 风格:xxx (Weiqi's list). */
export const STYLES: Record<string, string> = {
  厚涂: 'impasto, painterly, oil painting (medium)',
  油画: 'oil painting (medium), painterly, traditional media',
  水彩: 'watercolor (medium), traditional media',
  平涂: 'flat color, anime coloring',
  赛璐璐: 'anime coloring, anime screencap',
  动画截图: 'anime screencap, anime coloring',
  像素: 'pixel art',
  素描: 'sketch, monochrome, greyscale, traditional media',
  线稿: 'lineart, monochrome',
  Q版: 'chibi',
  光影: 'dramatic lighting, chiaroscuro, rim lighting',
};

// ---- content rules (never off) ----

/** Minors: always refused, whatever the switches. */
const MINOR_RE = /(?<![a-z])(?:loli|minor)(?![a-z])|萝莉|未成年/i;
const MINOR_NEG = 'futa, futanari';
export const NSFW_NEG = 'nsfw, explicit, nude, nipples, pussy, penis, sex';
export const NSFW_RE = /\b(nsfw|nude|naked|nudity|topless|bottomless|nipples?|areolae?|pussy|vagina|penis|sex|cum|breasts? out|no (?:bra|panties|clothes)|undressing|r-?18|hentai|explicit|rating:\s*(?:explicit|questionable))\b|裸|色情|涩图|色图|瑟图|做爱|性交|性爱|乳头|乳首|阴部|下体|露点|R18|r18|H图|h图|无码/i;

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function blockRe(words: string[]): RegExp | null {
  const w = words.map((x) => x.trim()).filter(Boolean);
  if (!w.length) return null;
  return new RegExp(w.map((t) => (/^[\x20-\x7e]+$/.test(t) ? `(?<![a-z])${escapeRe(t)}(?![a-z])` : escapeRe(t))).join('|'), 'i');
}

/** Why a prompt can't be drawn here ('' = fine). */
export function promptProblem(text: string, nsfwAllowed: boolean, blockWords: string[] = []): string {
  if (MINOR_RE.test(text)) return '描述里有未成年相关内容，不画。';
  if (!nsfwAllowed) {
    const m = NSFW_RE.exec(text);
    if (m) return `这里没开 NSFW（命中「${m[0]}」），不画。频道管理员可以在频道设置里打开。`;
  }
  const b = blockRe(blockWords)?.exec(text);
  if (b) return `描述里有屏蔽的内容（${b[0]}），不画。`;
  return '';
}

// ---- commands ----

export type CommandKind = 'draw' | 'charref' | 'vibe' | 'upscale' | 'tags' | 'balance';

export interface DrawCommand {
  kind: CommandKind;
  /** /nai5 (V5) instead of /nai (V4.5). */
  v5: boolean;
  /** What follows the command. */
  text: string;
}

const CMDS: [RegExp, CommandKind, boolean][] = [
  [/^(?:nai5|NAI5|Nai5)(?![a-zA-Z0-9])/, 'draw', true],
  [/^(?:nai|NAI|Nai)(?:余额|额度)/, 'balance', false],
  [/^(?:nai|NAI|Nai)(?![a-zA-Z0-9])/, 'draw', false],
  [/^(?:角色参考|角色迁移|人物参考)/, 'charref', false],
  [/^(?:风格迁移|画风迁移|vibe)(?![a-zA-Z])/, 'vibe', false],
  [/^(?:高清放大|放大|upscale)(?![a-zA-Z])/, 'upscale', false],
  [/^(?:查标签|查画师|标签联想)/, 'tags', false],
];

/** The command words (for the help text and the runner). */
export const COMMAND_WORDS = ['nai', 'nai5', 'nai余额', '角色参考', '风格迁移', '放大', '查标签'];

/**
 * Reads a drawing command: one of the command starts (default "/"), then
 * the command. @-mentions before it are skipped. null = not a command.
 */
export function parseCommand(message: string, starts: string[] = ['/']): DrawCommand | null {
  const t = message.replace(/^(\s*@\S+)+\s*/, '').trimStart();
  for (const st of starts.length ? starts : ['/']) {
    if (!t.startsWith(st)) continue;
    const rest = t.slice(st.length);
    for (const [re, kind, v5] of CMDS) {
      const m = re.exec(rest);
      if (m) return { kind, v5, text: rest.slice(m[0].length).trim() };
    }
  }
  return null;
}

/** Leading 横图 / 方图 / 竖图 / 精绘 / *N and 步数N anywhere. */
export function drawOptions(text: string, maxCount = 8) {
  let orientation: Orientation = 'portrait';
  let fine = false;
  let n = 1;
  let steps: number | undefined;
  const notes: string[] = [];
  const sm = /步数\s*[:：]?\s*(\d{1,2})/.exec(text);
  if (sm) {
    steps = Math.max(1, Math.min(MAX_STEPS, Number(sm[1])));
    text = (text.slice(0, sm.index) + text.slice(sm.index + sm[0].length)).replace(/^[\s，,]+|[\s，,]+$/g, '');
  }
  for (let changed = true; changed; ) {
    changed = false;
    const mc = /^[*×xX＊]\s*(\d{1,2})(?!\d)\s*/.exec(text);
    if (mc) {
      n = Math.max(1, Number(mc[1]));
      text = text.slice(mc[0].length).replace(/^[\s，,]+/, '');
      changed = true;
    }
    for (const [key, val] of [['横图', 'landscape'], ['方图', 'square'], ['竖图', 'portrait'], ['精绘', 'fine']] as const) {
      if (text.startsWith(key)) {
        text = text.slice(key.length).replace(/^[\s，,]+/, '');
        changed = true;
        if (val === 'fine') fine = true;
        else orientation = val;
      }
    }
  }
  if (n > maxCount) {
    notes.push(`一次最多 ${maxCount} 张，按 ${maxCount} 张出`);
    n = maxCount;
  }
  return { text: text.trim(), orientation, fine, n, steps, notes };
}

/** 强度0.8 anywhere (0.05–1). */
export function takeStrength(text: string): { text: string; strength?: number } {
  const m = /强度\s*[:：]?\s*([0-9]*\.?[0-9]+)/.exec(text);
  if (!m) return { text };
  const v = Number(m[1]);
  return { text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/^[\s，,]+|[\s，,]+$/g, ''), strength: Number.isFinite(v) ? Math.max(0.05, Math.min(1, v)) : undefined };
}

/** ||a|b|c|| -> one of them (the NovelAI site's syntax; the API doesn't know it). */
export function pickRandom(text: string, rand: () => number = Math.random): string {
  return text.replace(/\|\|([\s\S]+?)\|\|/g, (_, inner: string) => {
    const opts = inner.split('|').map((x) => x.trim()).filter(Boolean);
    return opts.length ? opts[Math.floor(rand() * opts.length)] : '';
  });
}

/**
 * The sectioned way of writing (NovelAI site / the 法典): main prompt, then
 * lines starting "char1:" / "char2:" / "Negative:" / "char1 Negative:"
 * (also 角色1： / 负面：).
 */
export function splitSections(text: string, rand: () => number = Math.random) {
  const re = /^[ \t]*(?:(?:char(?:acter)?|角色)[ \t]*(\d)[ \t]*(negative|neg|uc|负面)?|(negative|neg|uc|负面|反向))[ \t]*[:：]/gim;
  const marks = [...text.matchAll(re)];
  if (!marks.length) return { text: pickRandom(text, rand), negative: '', chars: [] as [string, string][], sectioned: false };
  const tidy = (t: string) => t.replace(/\s*\n\s*/g, ' ').trim().replace(/^[,，\s]+|[,，\s]+$/g, '');
  const neg: string[] = [];
  const chars = new Map<number, [string, string]>();
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index! : text.length;
    const body = pickRandom(text.slice(m.index! + m[0].length, end), rand).trim().replace(/^[,，\s]+|[,，\s]+$/g, '');
    if (m[1]) {
      const c = chars.get(Number(m[1])) ?? ['', ''];
      c[m[2] ? 1 : 0] = body;
      chars.set(Number(m[1]), c);
    } else neg.push(body);
  });
  return {
    text: tidy(pickRandom(text.slice(0, marks[0].index), rand)),
    negative: tidy(neg.filter(Boolean).join(', ')),
    chars: [...chars.keys()].sort((a, b) => a - b).map((k) => [tidy(chars.get(k)![0]), tidy(chars.get(k)![1])] as [string, string]).filter(([p]) => p),
    sectioned: true,
  };
}

/** 画师:wlop / 风格:厚涂 -> artist / style tags; unknown styles stay in the description. */
export function styleSpecs(text: string) {
  const tags: string[] = [];
  const notes: string[] = [];
  text = text.replace(/画师[:：]\s*([^,，;；\n]+?)(?=\s+\S+[:：]|[,，;；\n]|$)/g, (_, names: string) => {
    for (let a of names.split(/[、/|]/)) {
      a = a.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
      if (a) tags.push('artist:' + a);
    }
    return ' ';
  });
  const keep: string[] = [];
  text = text.replace(/(?:风格|画风)[:：]\s*([^\s,，;；]+)/g, (_, name: string) => {
    if (STYLES[name]) tags.push(STYLES[name]);
    else {
      keep.push(`画风：${name}`);
      notes.push(`「${name}」不在预设风格里，按描述理解了（预设有：${Object.keys(STYLES).join('、')}）`);
    }
    return ' ';
  });
  text = text.replace(/^[\s，,]+|[\s，,]+$/g, '').replace(/\s{2,}/g, ' ');
  if (keep.length) text = [text, ...keep].filter(Boolean).join('，');
  return { text, tags: tags.join(', '), notes };
}

/** Starts with 原样: sent word for word. */
export function takeRaw(text: string): { raw: boolean; text: string } {
  const m = /^\s*原样\s*[,，:：]?\s*/.exec(text);
  return m ? { raw: true, text: text.slice(m[0].length) } : { raw: false, text };
}

/** Has Chinese / Japanese characters (V4.5 needs them translated). */
export const hasCJK = (t: string) => /[぀-ヿ㐀-鿿]/.test(t);

// ---- the request ----

export interface DrawRequest {
  prompt: string;
  model: string;
  orientation?: Orientation;
  negative?: string;
  /** [character prompt, its negative] (V4 multi-character). */
  chars?: [string, string][];
  seed?: number;
  steps?: number;
  scale?: number;
  quality?: boolean;
  n?: number;
  large?: boolean;
  /** img2img: the picture (PNG base64, already cropped to width / height). */
  image?: { b64: string; width: number; height: number };
  /** Vibe transfer: [encoded vibe, strength]. */
  vibes?: [string, number][];
  /** Character reference: pictures (PNG base64, already padded). */
  references?: string[];
  refMode?: string;
  nsfwAllowed: boolean;
}

const roundUp64 = (v: number) => Math.max(64, Math.ceil(v / 64) * 64);

/** Size for a request: normal sizes stay within 1024×1024 pixels (free on Opus). */
export function sizeFor(orientation: Orientation = 'portrait', large = false): [number, number] {
  if (large) return LARGE_SIZES[orientation];
  let [w, h] = SIZES[orientation].map(roundUp64) as [number, number];
  if (w * h > 1024 * 1024) {
    const s = Math.sqrt((1024 * 1024) / (w * h));
    w = Math.floor((w * s) / 64) * 64;
    h = Math.floor((h * s) / 64) * 64;
  }
  return [w, h];
}

/** Which normal size a picture of this shape is cropped to for img2img. */
export function orientationOf(width: number, height: number): Orientation {
  const r = width / height;
  return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square';
}

/** Canvas size a character reference picture is padded into. */
export function referenceCanvas(width: number, height: number): [number, number] {
  const r = width / height;
  return r > 1.15 ? [1536, 1024] : r < 0.87 ? [1024, 1536] : [1472, 1472];
}

/** The body of a generate-image request (Weiqi's build_payload). */
export function buildPayload(r: DrawRequest, s: DrawSettings, rand: () => number = Math.random) {
  let [w, h] = r.image ? [r.image.width, r.image.height] : sizeFor(r.orientation, r.large);
  const seed = r.seed === undefined ? Math.floor(rand() * 4294967288) : Math.abs(Math.floor(r.seed)) % 4294967288;
  let prompt = r.prompt.trim().replace(/^[\s,]+|[\s,]+$/g, '');
  const chars = (r.chars ?? []).map(([p, n]) => [p.trim().replace(/^[\s,]+|[\s,]+$/g, ''), (n ?? '').trim()] as [string, string]).filter(([p]) => p);
  if (r.nsfwAllowed && s.autoNsfw && NSFW_RE.test(prompt) && !/\bnsfw\b|rating:explicit/i.test(prompt)) prompt = 'nsfw, ' + prompt;
  const quality = r.quality !== false;
  const qtags = r.model.includes('diffusion-5') ? s.qualityV5 : s.quality;
  const full = [prompt, quality ? qtags : ''].filter(Boolean).join(', ');
  const userNeg = s.blockWords.filter((t) => /^[\x20-\x7e]+$/.test(t)).join(', ');
  const neg = [s.negative, r.negative ?? '', MINOR_NEG, userNeg, r.nsfwAllowed ? '' : NSFW_NEG].filter(Boolean).join(', ');
  const steps = Math.max(1, Math.min(MAX_STEPS, Math.round(r.steps ?? s.steps)));
  const params: Record<string, unknown> = {
    params_version: 3, width: w, height: h, scale: r.scale ?? s.scale, sampler: s.sampler, steps,
    n_samples: Math.max(1, Math.min(4, r.n ?? 1)), ucPreset: 4, qualityToggle: quality, autoSmea: false, dynamic_thresholding: false,
    controlnet_strength: 1, legacy: false, add_original_image: true, cfg_rescale: 0, noise_schedule: 'karras', legacy_v3_extend: false,
    skip_cfg_above_sigma: null, use_coords: false, legacy_uc: false, normalize_reference_strength_multiple: true, seed, negative_prompt: neg,
    characterPrompts: chars.map(([p, n]) => ({ prompt: p, uc: n || 'lowres, aliasing', center: { x: 0.5, y: 0.5 }, enabled: true })),
    v4_prompt: { caption: { base_caption: full, char_captions: chars.map(([p]) => ({ char_caption: p, centers: [{ x: 0.5, y: 0.5 }] })) }, use_coords: false, use_order: true },
    v4_negative_prompt: { caption: { base_caption: neg, char_captions: chars.map(([, n]) => ({ char_caption: n || 'lowres, aliasing', centers: [{ x: 0.5, y: 0.5 }] })) }, legacy_uc: false },
  };
  if (s.sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }
  let action = 'generate';
  if (r.image) {
    Object.assign(params, { image: r.image.b64, strength: s.strength, noise: 0, extra_noise_seed: seed, sm: false, sm_dyn: false });
    action = 'img2img';
  }
  if (r.vibes?.length) {
    params.reference_image_multiple = r.vibes.map(([v]) => v);
    params.reference_strength_multiple = r.vibes.map(([, k]) => k);
  }
  if (r.references?.length) {
    delete params.reference_image_multiple;
    delete params.reference_strength_multiple;
    delete params.normalize_reference_strength_multiple;
    Object.assign(params, {
      director_reference_images: r.references,
      director_reference_descriptions: r.references.map(() => ({ caption: { base_caption: r.refMode ?? 'character', char_captions: [] }, legacy_uc: false })),
      director_reference_information_extracted: r.references.map(() => 1),
      director_reference_strength_values: r.references.map(() => s.refStrength),
      director_reference_secondary_strength_values: r.references.map(() => s.refFidelity),
    });
  }
  return { input: full, model: r.model, action, parameters: params };
}

/** Is this request free on an Opus subscription (one normal-size picture, ≤ 28 steps, no picture in)? */
export function isFree(p: ReturnType<typeof buildPayload>): boolean {
  const q = p.parameters as { width: number; height: number; steps: number; n_samples: number; image?: string; director_reference_images?: unknown; reference_image_multiple?: unknown };
  return q.n_samples === 1 && q.width * q.height <= 1024 * 1024 && q.steps <= 28 && !q.image && !q.director_reference_images && !q.reference_image_multiple;
}

// ---- answers ----

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNGs in a generate-image / upscale answer (a zip; or a stream with a PNG inside). */
export function extractPngs(data: Uint8Array): Uint8Array[] {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const files = unzipSync(data);
    const names = Object.keys(files).filter((n) => !n.endsWith('/')).sort();
    if (!names.length) throw new Error('NovelAI 返回的压缩包是空的');
    return names.map((n) => files[n]);
  }
  for (let i = data.length - 8; i >= 0; i--) {
    if (PNG_SIG.every((b, k) => data[i + k] === b)) {
      for (let j = i; j < data.length - 3; j++) {
        if (data[j] === 0x49 && data[j + 1] === 0x45 && data[j + 2] === 0x4e && data[j + 3] === 0x44) return [data.slice(i, j + 8)];
      }
    }
  }
  throw new Error('NovelAI 返回的内容看不懂');
}

export interface NaiBalance {
  anlas: number | null;
  tier: number | null;
  expires: number | null;
  /** V5 allowance left (%). */
  battery: number | null;
}

/** /user/subscription answer. */
export function parseSubscription(json: string): NaiBalance {
  const d = JSON.parse(json) as Record<string, unknown>;
  const left = d.trainingStepsLeft as unknown;
  let anlas: number | null = null;
  if (left && typeof left === 'object') {
    const o = left as Record<string, number>;
    anlas = Number(o.fixedTrainingStepsLeft ?? 0) + Number(o.purchasedTrainingSteps ?? 0);
  } else if (typeof left === 'number') anlas = left;
  else if (d.fixedTrainingStepsLeft !== undefined || d.purchasedTrainingSteps !== undefined) anlas = Number(d.fixedTrainingStepsLeft ?? 0) + Number(d.purchasedTrainingSteps ?? 0);
  const usage = (d.usage ?? {}) as Record<string, unknown>;
  return {
    anlas, tier: typeof d.tier === 'number' ? d.tier : null, expires: typeof d.expiresAt === 'number' ? d.expiresAt : null,
    battery: typeof usage.percent === 'number' ? usage.percent : null,
  };
}

export function balanceText(b: NaiBalance): string {
  if (b.anlas === null) return 'NovelAI：查不到余额';
  const tier = b.tier === null ? '' : TIERS[b.tier] ?? String(b.tier);
  const exp = b.expires ? `，到期 ${new Date(b.expires * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}` : '';
  const bat = b.battery === null ? '' : `，V5 额度 ${b.battery}%`;
  return `NovelAI：${tier}${exp}，剩余 ${b.anlas} Anlas${bat}`;
}

/** "剩余 x Anlas（这次花了 y）" */
export function costNote(before: number | null, after: number | null, paid: boolean): string {
  if (after === null) return '';
  const spent = before !== null ? before - after : null;
  let note = `剩余 ${after} Anlas`;
  if (spent && spent > 0) note += `（这次花了 ${spent}）`;
  else if (paid && spent === 0) note += '（余额没变：可能这项 Opus 也免费，也可能余额还没刷新）';
  return note;
}

/** An error answer from NovelAI, in words. */
export function errorText(status: number, body: string): string {
  let msg = body.slice(0, 200);
  try {
    const d = JSON.parse(body) as { message?: string; error?: string };
    msg = d.message || d.error || msg;
  } catch {
    /* plain text */
  }
  const known: Record<number, string> = {
    400: `参数不对：${msg}`,
    401: 'token 无效或过期（NovelAI 网页 → 设置 → Account → Get Persistent API Token）',
    402: `Anlas 不够或者订阅不支持：${msg}`,
    403: `被拒绝：${msg}`,
    409: `冲突：${msg}`,
    429: 'NovelAI 说同时请求太多了（一个账号同时只能画一张），稍后再试',
    500: `NovelAI 服务器出错：${msg}`,
  };
  return known[status] ?? `HTTP ${status}：${msg}`;
}

/** suggest-tags answer -> lines for the chat. */
export function tagsText(query: string, v5: boolean, json: string[]): string {
  const seen = new Set<string>();
  const tags: { tag: string; count?: number; confidence?: number }[] = [];
  for (const j of json) {
    try {
      for (const t of (JSON.parse(j) as { tags?: { tag?: string; count?: number; confidence?: number }[] }).tags ?? []) {
        if (t.tag && !seen.has(t.tag)) {
          seen.add(t.tag);
          tags.push(t as { tag: string });
        }
      }
    } catch {
      /* skip */
    }
  }
  if (!tags.length) return `NovelAI 不认识「${query}」开头的标签，换个拼法试试（画师名用 Danbooru 上的英文写法）`;
  tags.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const lines = [`NovelAI ${v5 ? 'V5' : 'V4.5'} 认识的「${query}」相关标签（按训练图数量排）：`];
  for (const t of tags.slice(0, 12)) {
    const extra = [t.count ? `${t.count} 张` : '', typeof t.confidence === 'number' ? (t.confidence <= 1 ? `把握 ${Math.round(t.confidence * 100)}%` : `把握 ${t.confidence}`) : ''].filter(Boolean);
    const name = t.tag.startsWith('artist:') ? '画师:' + t.tag.slice(7) : t.tag;
    lines.push(`• ${name}${extra.length ? `（${extra.join('，')}）` : ''}`);
  }
  lines.push('张数越多越认得、效果越明显；张数很少的填了基本没感觉');
  return lines.join('\n');
}

/** The usage text for a command (when it's sent without anything to draw). */
export function usage(kind: CommandKind, maxCount: number): string {
  switch (kind) {
    case 'charref':
      return '用法：带一张图（或回复一张图）发「/角色参考 <要画什么>」，照那张图里的角色画新的画面（每张约 5 Anlas）。可以加「强度0.8」、横图 / 方图、*N。';
    case 'vibe':
      return '用法：带一张图（或回复一张图）发「/风格迁移 <要画什么>」，照那张图的画风画新内容（新图编码约 2 Anlas）。可以加「强度0.8」（默认 0.6）、*N。';
    case 'upscale':
      return '用法：回复一张图发「/放大」，NovelAI 放大 2 倍（不重画，会扣 Anlas）。';
    case 'tags':
      return '用法：/查标签 mika（打名字的前几个字母就行），看 NovelAI 认不认识、训练图有多少张；开头加 v5 查 V5 的。';
    default:
      return `用法：/nai <描述>（V4.5）或 /nai5 <描述>（V5），例如：/nai5 银发猫耳女孩，夜晚，霓虹街道\n开头可以加：横图 / 方图；精绘（大尺寸，扣 Anlas）；*4（一次出几张，最多 ${maxCount}）\n分段写法：主提示词后面换行写 char1: / char2: / Negative: / char1 Negative:\n描述里写「步数40」改步数（最多 50，超过 28 扣 Anlas）；开头写「原样」一个字不改\n/nai 的中文会翻成英文；/nai5 直接用中文；可以写 画师:xxx、风格:厚涂\n带一张图（或回复一张图）= 在原图上改（扣 Anlas）。其他：/角色参考 /风格迁移 /放大 /查标签 /nai余额`;
  }
}
