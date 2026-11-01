// NovelAI drawing for an AI this device runs (docs/design.md §9 画画): the
// requests (through Rust, with the owner's token and proxy), the pictures
// (decoded and cropped in the WebView), the `/nai …` commands and the
// `draw_picture` tool. Rules and request building are pure in lib/ai/nai.ts.
import { inTauri } from '../platform';
import type { Session } from '../session';
import type { Message } from '../types';
import {
  IMAGE_URL, NSFW_RE, SUB_URL, SUGGEST_URL, UPSCALE_URL, VIBE_URL, balanceText, buildPayload, costNote, drawOptions, errorText, extractPngs,
  hasCJK, isFree, orientationOf, parseSubscription, promptProblem, referenceCanvas, sizeFor, splitSections, styleSpecs, tagsText,
  takeRaw, takeStrength, usage, type DrawCommand, type DrawRequest, type DrawSettings, type NaiBalance, type Orientation,
} from './nai';

/** Everything a drawing needs from the runner. */
export interface NaiDeps {
  s: Session;
  aiId: string;
  ownerId: string;
  draw: DrawSettings;
  /** The NovelAI API token ('' = drawing is off). */
  token: string;
  /** Chinese -> English with the AI's own model (V4.5 descriptions). */
  translate: (text: string) => Promise<string>;
  /** Adult content allowed in this conversation (channel switch / DM setting). */
  nsfwAllowed: (convId: string) => boolean;
}

class DrawError extends Error {}

// ---- network ----

/** Browser development / e2e: NovelAI is a local stand-in (AM_DEV_NAI). */
const devNai = !inTauri && typeof __AM_DEV_NAI__ === 'string' && __AM_DEV_NAI__ ? __AM_DEV_NAI__.replace(/\/+$/, '') : '';

async function request(d: NaiDeps, method: 'GET' | 'POST', url: string, body?: unknown, timeout = 120): Promise<Uint8Array> {
  const json = body === undefined ? undefined : JSON.stringify(body);
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return new Uint8Array(await invoke<ArrayBuffer>('nai_request', { method, url, token: d.token, body: json ?? null, proxy: d.draw.proxy.trim(), timeout }));
    } catch (e) {
      const m = /^(\d+) ([\s\S]*)$/.exec(String(e));
      throw new DrawError(m && m[1] !== '0' ? 'NovelAI：' + errorText(Number(m[1]), m[2]) : m ? m[2] : String(e));
    }
  }
  const target = devNai ? url.replace(/^https:\/\/image\.novelai\.net/, devNai) : url;
  const r = await fetch(target, { method, headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' }, body: json });
  const b = new Uint8Array(await r.arrayBuffer());
  if (!r.ok) throw new DrawError('NovelAI：' + errorText(r.status, new TextDecoder().decode(b)));
  return b;
}

/** One request at a time per account (NovelAI answers 429 otherwise). */
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(token: string, job: () => Promise<T>): Promise<T> {
  const prev = locks.get(token) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  locks.set(token, next);
  return next;
}

const balances = new Map<string, { at: number; b: NaiBalance }>();
async function balance(d: NaiDeps, force = false): Promise<NaiBalance | null> {
  const c = balances.get(d.token);
  if (!force && c && Date.now() - c.at < 5 * 60_000) return c.b;
  try {
    const b = parseSubscription(new TextDecoder().decode(await request(d, 'GET', SUB_URL, undefined, 20)));
    balances.set(d.token, { at: Date.now(), b });
    return b;
  } catch {
    return c?.b ?? null;
  }
}

// ---- pictures ----

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function decode(bytes: Uint8Array): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes.slice()]));
  } catch {
    throw new DrawError('这张图读不出来');
  }
}

async function toPng(draw: (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => void, w: number, h: number): Promise<string> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    draw(c.getContext('2d')!);
    return b64(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const blob = await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), 'image/png'));
  return b64(new Uint8Array(await blob.arrayBuffer()));
}

/** img2img: scaled and cropped to the normal size nearest its shape. */
async function fitImage(bytes: Uint8Array) {
  const im = await decode(bytes);
  const [w, h] = sizeFor(orientationOf(im.width, im.height));
  const s = Math.max(w / im.width, h / im.height);
  const dw = im.width * s;
  const dh = im.height * s;
  return { b64: await toPng((ctx) => ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh), w, h), width: w, height: h };
}

/** Character reference: fitted into 1024×1536 / 1536×1024 / 1472×1472 with black around it. */
async function padReference(bytes: Uint8Array) {
  const im = await decode(bytes);
  const [w, h] = referenceCanvas(im.width, im.height);
  const s = Math.min(w / im.width, h / im.height);
  const dw = Math.max(1, Math.round(im.width * s));
  const dh = Math.max(1, Math.round(im.height * s));
  return toPng((ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }, w, h);
}

/** A picture as PNG, made smaller than ~1 megapixel (vibe encoding, upscaling). */
async function shrinkPng(bytes: Uint8Array, maxPixels = 1024 * 1024) {
  const im = await decode(bytes);
  const s = Math.min(1, Math.sqrt(maxPixels / (im.width * im.height)));
  const w = Math.max(1, Math.round(im.width * s));
  const h = Math.max(1, Math.round(im.height * s));
  return { b64: await toPng((ctx) => ctx.drawImage(im, 0, 0, w, h), w, h), width: w, height: h };
}

/** Vibes encoded already (same picture, same model: no Anlas again). */
const vibeCache = new Map<string, string>();
async function encodeVibe(d: NaiDeps, bytes: Uint8Array, model: string): Promise<string> {
  const key = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))) + model;
  const hit = vibeCache.get(key);
  if (hit) return hit;
  const img = await shrinkPng(bytes);
  const v = b64(await request(d, 'POST', VIBE_URL, { image: img.b64, information_extracted: 1, model }, 60));
  vibeCache.set(key, v);
  if (vibeCache.size > 100) vibeCache.delete(vibeCache.keys().next().value!);
  return v;
}

// ---- drawing ----

interface Job extends Omit<DrawRequest, 'model' | 'nsfwAllowed' | 'image' | 'vibes' | 'references'> {
  v5: boolean;
  image?: Uint8Array;
  vibeImages?: Uint8Array[];
  vibeStrength?: number;
  references?: Uint8Array[];
}

/** Draws (several requests when more than 4) -> PNGs and a note. */
async function draw(d: NaiDeps, convId: string, j: Job): Promise<{ pngs: Uint8Array[]; note: string }> {
  const model = j.v5 ? d.draw.v5Model : d.draw.model;
  const nsfwAllowed = d.nsfwAllowed(convId);
  const vibes = j.vibeImages?.length ? await Promise.all(j.vibeImages.map(async (v) => [await encodeVibe(d, v, model), j.vibeStrength ?? d.draw.vibeStrength] as [string, number])) : undefined;
  const references = j.references?.length ? await Promise.all(j.references.map(padReference)) : undefined;
  const image = j.image ? await fitImage(j.image) : undefined;
  const before = (await balance(d))?.anlas ?? null;
  const start = Date.now();
  const pngs: Uint8Array[] = [];
  let paid = false;
  let first = true;
  for (let left = Math.max(1, j.n ?? 1); left > 0; left -= 4) {
    const payload = buildPayload({ ...j, model, nsfwAllowed, image, vibes, references, n: Math.min(4, left), seed: first ? j.seed : undefined }, d.draw);
    paid ||= !isFree(payload);
    first = false;
    const n = Math.min(4, left);
    pngs.push(...extractPngs(await serialized(d.token, () => request(d, 'POST', IMAGE_URL, payload, 120 * (1 + 0.5 * (n - 1))))));
  }
  const after = (await balance(d, true))?.anlas ?? null;
  const secs = Math.round((Date.now() - start) / 1000);
  const steps = Math.max(1, Math.min(50, Math.round(j.steps ?? d.draw.steps)));
  let note = `NovelAI ${j.v5 ? 'V5' : 'V4.5'}，${secs} 秒`;
  if (steps !== 28) note += `，${steps} 步`;
  const cost = costNote(before, after, paid);
  return { pngs, note: cost ? `${note}，${cost}` : note };
}

/** Sends the pictures, labelled for the museum ("NovelAI V5", adult content). */
async function sendPictures(d: NaiDeps, convId: string, pngs: Uint8Array[], made?: { with: string; nsfw: boolean }) {
  for (const [i, png] of pngs.entries()) {
    await d.s.sendFile(convId, new File([png.slice()], `nai-${Date.now()}-${i}.png`, { type: 'image/png' }), made);
  }
}

const madeBy = (v5: boolean, prompt: string, nsfwAllowed: boolean) => ({ with: `NovelAI ${v5 ? 'V5' : 'V4.5'}`, nsfw: nsfwAllowed && NSFW_RE.test(prompt) });

/** Pictures the command came with: an image the same person sent just before, or the one it replies to. */
async function picturesFor(d: NaiDeps, convId: string, m: Message, limit = 2): Promise<Uint8Array[]> {
  const list = d.s.view.messages[convId] ?? [];
  const ids: string[] = [];
  const replyTo = m.body.kind === 'text' ? m.body.replyTo : undefined;
  if (replyTo) {
    const r = list.find((x) => x.id === replyTo);
    if (r?.body.kind === 'image') ids.push(r.body.mediaId);
  }
  const at = list.findIndex((x) => x.id === m.id);
  for (let i = (at < 0 ? list.length : at) - 1; i >= 0 && ids.length < limit; i--) {
    const x = list[i];
    if (x.senderId !== m.senderId || m.time - x.time > 2 * 60_000) break;
    if (x.body.kind === 'image') ids.push(x.body.mediaId);
    else break;
  }
  return Promise.all(ids.slice(0, limit).map(async (id) => new Uint8Array(await (await d.s.t.mediaBytes(`/api/v1/media/${id}`)).arrayBuffer())));
}

/** Description -> what goes to NovelAI: 原样 kept, V5 Chinese kept (v5Native), V4.5 Chinese translated. */
async function english(d: NaiDeps, text: string, v5: boolean): Promise<string> {
  const r = takeRaw(text);
  if (r.raw || !r.text.trim() || !hasCJK(r.text) || (v5 && d.draw.v5Native)) return r.text.trim();
  let out: string;
  try {
    out = (await d.translate(r.text)).trim().replace(/^["“”「」]+|["“”「」]+$/g, '');
  } catch (e) {
    throw new DrawError(`把描述翻成英文失败（${e instanceof Error ? e.message : String(e)}），没画`);
  }
  if (!out || (out.match(/[一-鿿]/g)?.length ?? 0) > out.length * 0.2) throw new DrawError('翻译结果不对劲，没画，再发一次试试');
  return out;
}

/** Translation prompt (Weiqi's): faithful, keeps NovelAI syntax. */
export const TRANSLATE_PROMPT = "You are a translator. Translate the user's text into natural English, faithfully and completely: keep every detail, do not add, remove, soften or censor anything, do not explain. Keep any parts that are already English, and keep special syntax unchanged (e.g. {word}, [word], 1.2::word::, artist:name). Write anime/game character names in their official English romanization. Output only the translation, nothing else.";

/** Handles a `/nai …` command message. Replies go to the conversation as the AI. */
export async function runCommand(d: NaiDeps, convId: string, m: Message, cmd: DrawCommand): Promise<void> {
  const say = (text: string) => d.s.sendText(convId, text, undefined, undefined, m.id);
  try {
    if (!d.token) throw new DrawError('还没接 NovelAI：主人在 AI 设置 →「画画」里填 token');
    if (cmd.kind === 'balance') {
      const b = await balance(d, true);
      await say(b ? balanceText(b) : 'NovelAI：查不到余额（token 或网络有问题）');
      return;
    }
    if (cmd.kind === 'tags') {
      let q = cmd.text;
      let v5 = false;
      const vm = /^(?:v5|nai5|5)\s+/i.exec(q);
      if (vm) {
        v5 = true;
        q = q.slice(vm[0].length);
      }
      if (!q) return void (await say(usage('tags', d.draw.maxCount)));
      const model = v5 ? d.draw.v5Model : d.draw.model;
      const queries = q.toLowerCase().startsWith('artist:') ? [q] : [`artist:${q}`, q];
      const answers = await Promise.all(queries.map(async (x) => new TextDecoder().decode(await request(d, 'GET', `${SUGGEST_URL}?model=${encodeURIComponent(model)}&prompt=${encodeURIComponent(x)}`, undefined, 20))));
      await say(tagsText(q, v5, answers));
      return;
    }
    if (cmd.kind === 'upscale') {
      const [img] = await picturesFor(d, convId, m, 1);
      if (!img) return void (await say(usage('upscale', d.draw.maxCount)));
      await say('收到，NovelAI 放大中（会扣 Anlas）…');
      const before = (await balance(d))?.anlas ?? null;
      const src = await shrinkPng(img, 1024 * 1024);
      const out = extractPngs(await serialized(d.token, () => request(d, 'POST', UPSCALE_URL, { image: src.b64, width: src.width, height: src.height, scale: 2 }, 120)));
      await sendPictures(d, convId, out);
      await say('NovelAI 放大 2 倍，' + costNote(before, (await balance(d, true))?.anlas ?? null, true));
      return;
    }
    // draw / charref / vibe
    let text = cmd.text;
    let strength: number | undefined;
    if (cmd.kind !== 'draw') ({ text, strength } = takeStrength(text));
    const opt = drawOptions(text, d.draw.maxCount);
    const sec = splitSections(opt.text);
    const sty = styleSpecs(sec.text);
    const notes = [...opt.notes, ...sty.notes];
    let v5 = cmd.v5;
    const pics = await picturesFor(d, convId, m, 2);
    if (cmd.kind !== 'draw' && !pics.length) return void (await say(usage(cmd.kind, d.draw.maxCount)));
    if (cmd.kind !== 'draw' && v5) {
      v5 = false; // NovelAI: character reference / vibe transfer are not on V5 yet.
      notes.push('角色参考 / 风格迁移 V5 还不支持，用的是 V4.5');
    }
    if (cmd.kind === 'draw' && !sty.text && !sty.tags && !sec.chars.length && !pics.length) return void (await say(usage('draw', d.draw.maxCount)));
    const problem = promptProblem([sty.text, sty.tags, sec.negative, ...sec.chars.flat()].join(' '), d.nsfwAllowed(convId), d.draw.blockWords);
    if (problem) return void (await say(problem));
    let prompt = sty.text ? await english(d, sty.text, v5) : '';
    const chars = await Promise.all(sec.chars.map(async ([p, n]) => [await english(d, p, v5), n ? await english(d, n, v5) : ''] as [string, string]));
    const negative = sec.negative ? await english(d, sec.negative, v5) : '';
    prompt = [sty.tags, prompt].filter(Boolean).join(', ') || (chars.length ? '' : '1girl, solo');
    // The translation may bring words the rules catch only in English.
    const again = promptProblem([prompt, negative, ...chars.flat()].join(' '), d.nsfwAllowed(convId), d.draw.blockWords);
    if (again) return void (await say(again));
    const extra = [cmd.kind === 'draw' && pics.length ? '带图重绘' : '', cmd.kind === 'charref' ? '角色参考' : '', cmd.kind === 'vibe' ? '风格迁移' : '',
      opt.fine ? '精绘' : '', opt.n > 1 ? `${opt.n} 张` : '', opt.steps ? `${opt.steps} 步` : ''].filter(Boolean);
    await say(`收到，NovelAI ${v5 ? 'V5' : 'V4.5'} 画图中${extra.length ? `（${extra.join('，')}，会扣 Anlas）` : ''}…`);
    const job: Job = {
      v5, prompt, negative, chars, orientation: opt.orientation, n: opt.n, steps: opt.steps, large: opt.fine,
      image: cmd.kind === 'draw' ? pics[0] : undefined,
      vibeImages: cmd.kind === 'vibe' ? pics : undefined, vibeStrength: strength,
      references: cmd.kind === 'charref' ? pics.slice(0, 1) : undefined,
    };
    const r = await draw(d, convId, job);
    await sendPictures(d, convId, r.pngs, madeBy(v5, [prompt, ...chars.flat()].join(' '), d.nsfwAllowed(convId)));
    await say([...notes, r.note].join('；'));
  } catch (e) {
    await say(e instanceof DrawError ? e.message : `没画成：${e instanceof Error ? e.message : String(e)}`).catch(() => {});
  }
}

/** The draw_picture tool: the model writes the English prompt itself. Returns the answer for the model. */
export async function drawForTool(d: NaiDeps, convId: string, a: Record<string, unknown>): Promise<string> {
  if (!d.token) return '画不了：主人还没在 AI 设置 →「画画」里接 NovelAI。';
  const prompt = String(a.prompt ?? '').trim();
  if (!prompt) return '要写 prompt（英文）。';
  const negative = String(a.negative ?? '').trim();
  const problem = promptProblem(`${prompt} ${negative}`, d.nsfwAllowed(convId), d.draw.blockWords);
  if (problem) return problem;
  const o = String(a.orientation ?? 'portrait');
  const orientation: Orientation = o === 'landscape' || o === 'square' ? o : 'portrait';
  const n = Math.max(1, Math.min(Math.min(4, d.draw.maxCount), Math.round(Number(a.count) || 1)));
  try {
    const r = await draw(d, convId, { v5: a.model === 'v5', prompt, negative, orientation, n });
    await sendPictures(d, convId, r.pngs, madeBy(a.model === 'v5', prompt, d.nsfwAllowed(convId)));
    return `画好了，${r.pngs.length} 张已经发到聊天里（${r.note}）。用一句话自然地说一下就行，不要再贴提示词。`;
  } catch (e) {
    return `没画成：${e instanceof Error ? e.message : String(e)}`;
  }
}
