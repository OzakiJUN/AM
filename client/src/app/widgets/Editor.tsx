// Dialogs for editing a profile board: a widget's settings (contents, size,
// page, who may edit it), the "add a widget" picker and the background.
// Changes go into the board's draft; the board saves them all at once.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ImagePlus, Plus, Trash2, X } from 'lucide-react';
import { current } from '@/lib/store';
import { GRADIENTS, KINDS, STAT_ITEMS, kindInfo, neteasePlaylistId, type KindInfo, type ProfileKind } from '@/lib/widgetKinds';
import { MAX_PAGES, MAX_SIDE, type Background, type WidgetModel } from '@/lib/widgets';
import { Button, Dialog, Field, Input, Segmented, Slider, Spinner, cx, inputClass, toastError } from '@/ui';
import { mediaPath, useMediaUrl } from '../media';

type Config = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Uploads picked images; resolves to their media ids. */
async function uploadImages(files: FileList | File[]): Promise<string[]> {
  const ids: string[] = [];
  for (const f of Array.from(files)) {
    const info = await current().upload(f);
    if (!info.isImage) throw new Error(`「${f.name}」不是图片`);
    ids.push(info.id.toString());
  }
  return ids;
}

function Thumb({ id, className }: { id: string; className?: string }) {
  const url = useMediaUrl(mediaPath(id, true));
  return <span className={cx('block overflow-hidden rounded-xl bg-black/5 dark:bg-white/5', className)}>{url && <img src={url} alt="" className="h-full w-full object-cover" />}</span>;
}

export interface EditTarget {
  widget: WidgetModel;
  /** May change size / page (layout rights). */
  layout: boolean;
  /** May change its contents. */
  content: boolean;
  /** May set who edits it (site admin, server profile). */
  editors: boolean;
}

/**
 * Settings of one widget. onApply gets the new widget, or null when the
 * user picked a size / page that doesn't fit (the board reports that).
 */
export function WidgetEditor({ target, profileKind, page, onClose, onApply }: {
  target: EditTarget | null;
  profileKind: ProfileKind;
  page: number;
  onClose: () => void;
  onApply: (w: WidgetModel, move: { size?: [number, number]; page?: number }) => boolean;
}) {
  const [cfg, setCfg] = useState<Config>({});
  const [size, setSize] = useState<[number, number]>([1, 1]);
  const [pg, setPg] = useState(0);
  const [admins, setAdmins] = useState(false);
  useEffect(() => {
    if (!target) return;
    setCfg({ ...target.widget.config });
    setSize([target.widget.w, target.widget.h]);
    setPg(page);
    setAdmins(target.widget.contentEditors === 'admins');
  }, [target, page]);
  if (!target) return <Dialog open={false} onClose={onClose}>{null}</Dialog>;
  const w = target.widget;
  const info = kindInfo(w.kind);
  const set = (p: Config) => setCfg((c) => ({ ...c, ...p }));
  const apply = () => {
    const ok = onApply(
      { ...w, config: cfg, contentEditors: target.editors ? (admins ? 'admins' : 'everyone') : w.contentEditors },
      { size: size[0] !== w.w || size[1] !== w.h ? size : undefined, page: pg !== page ? pg : undefined },
    );
    if (ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`${info?.emoji ?? '🧩'} ${info?.label ?? w.kind}`} width={520}>
      <div className="max-h-[62vh] space-y-4 overflow-y-auto pr-1">
        {w.source === 'builtin' && target.content && <ConfigForm kind={w.kind} cfg={cfg} set={set} profileKind={profileKind} />}
        {!target.content && <p className="text-[0.85rem] text-ink-soft dark:text-white/55">这个小组件的内容只有管理员能改，你可以调整它的大小和位置。</p>}
        {target.layout && info && (
          <Field label="大小（宽 × 高，格）">
            <div className="flex flex-wrap gap-1.5">
              {sizes(info).map(([sw, sh]) => (
                <button
                  key={`${sw}x${sh}`}
                  onClick={() => setSize([sw, sh])}
                  aria-pressed={size[0] === sw && size[1] === sh}
                  className={cx('press rounded-lg px-2.5 py-1 text-[0.85rem] tabular-nums', size[0] === sw && size[1] === sh ? 'bg-accent text-white' : 'bg-black/[0.05] dark:bg-white/10')}
                >
                  {sw}×{sh}
                </button>
              ))}
            </div>
          </Field>
        )}
        {target.layout && (
          <Field label="放在第几页">
            <Segmented id="widget-page" value={String(pg)} onChange={(v) => setPg(Number(v))} options={Array.from({ length: MAX_PAGES }, (_, i) => ({ value: String(i), label: `第 ${i + 1} 页` }))} />
          </Field>
        )}
        {target.editors && (
          <label className="flex items-center gap-3 rounded-2xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
            <input type="checkbox" checked={admins} onChange={(e) => setAdmins(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">只有管理员能改这个小组件的内容</span>
              <span className="block text-[0.8rem] text-ink-soft dark:text-white/50">服务器允许成员改小组件内容时，这个小组件仍然只有管理员能改</span>
            </span>
          </label>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={apply}>好了</Button>
      </div>
    </Dialog>
  );
}

function sizes(k: KindInfo): [number, number][] {
  const out: [number, number][] = [];
  for (let h = k.minH; h <= MAX_SIDE; h++) for (let w = k.minW; w <= MAX_SIDE; w++) out.push([w, h]);
  return out;
}

function ConfigForm({ kind, cfg, set, profileKind }: { kind: string; cfg: Config; set: (p: Config) => void; profileKind: ProfileKind }) {
  switch (kind) {
    case 'text':
      return (
        <>
          <Field label="标题"><Input value={str(cfg.title)} maxLength={40} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field label="内容">
            <textarea value={str(cfg.text)} maxLength={1000} rows={6} onChange={(e) => set({ text: e.target.value })} className={cx(inputClass, 'resize-none py-2.5 leading-relaxed')} />
          </Field>
        </>
      );
    case 'image':
      return (
        <>
          <ImagePick ids={str(cfg.media_id) ? [str(cfg.media_id)] : []} max={1} onChange={(ids) => set({ media_id: ids[0] ?? '' })} />
          <Field label="说明"><Input value={str(cfg.caption)} maxLength={80} onChange={(e) => set({ caption: e.target.value })} /></Field>
          <Field label="显示方式">
            <Segmented id="image-fit" value={str(cfg.fit) === 'contain' ? 'contain' : 'cover'} onChange={(v) => set({ fit: v })} options={[{ value: 'cover', label: '铺满' }, { value: 'contain', label: '完整显示' }]} />
          </Field>
        </>
      );
    case 'gallery': {
      const ids = Array.isArray(cfg.media_ids) ? (cfg.media_ids as string[]) : [];
      const interval = typeof cfg.interval === 'number' ? cfg.interval : 5;
      return (
        <>
          <ImagePick ids={ids} max={20} onChange={(next) => set({ media_ids: next })} />
          <Field label={`轮播间隔：${interval} 秒`}><Slider label="轮播间隔" value={interval} min={2} max={30} step={1} onChange={(v) => set({ interval: v })} /></Field>
          <Field label="说明"><Input value={str(cfg.caption)} maxLength={80} onChange={(e) => set({ caption: e.target.value })} /></Field>
        </>
      );
    }
    case 'links': {
      const items = Array.isArray(cfg.items) ? (cfg.items as { title: string; url: string }[]) : [];
      const put = (next: typeof items) => set({ items: next });
      return (
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="flex gap-2">
              <Input className="w-32 shrink-0" value={it.title} maxLength={30} placeholder="名字" onChange={(e) => put(items.map((x, n) => (n === i ? { ...x, title: e.target.value } : x)))} />
              <Input value={it.url} maxLength={300} placeholder="https://…" onChange={(e) => put(items.map((x, n) => (n === i ? { ...x, url: e.target.value.trim() } : x)))} />
              <Button variant="ghost" aria-label="删除链接" onClick={() => put(items.filter((_, n) => n !== i))}><Trash2 size={15} /></Button>
            </div>
          ))}
          {items.length < 6 && <Button variant="soft" size="sm" onClick={() => put([...items, { title: '', url: 'https://' }])}><Plus size={15} /> 加一个链接</Button>}
          <p className="text-[0.8rem] text-ink-soft dark:text-white/45">只能填 http:// 或 https:// 开头的链接，别人点开前会先确认。</p>
        </div>
      );
    }
    case 'countdown': {
      const date = typeof cfg.date === 'number' && cfg.date > 0 ? new Date(cfg.date) : null;
      const value = date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : '';
      return (
        <>
          <Field label="标题"><Input value={str(cfg.title)} maxLength={30} placeholder="例如：生日、考试、开服纪念日" onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field label="日期">
            <Input type="date" value={value} onChange={(e) => {
              const [y, m, d] = e.target.value.split('-').map(Number);
              set({ date: y ? new Date(y, m - 1, d).getTime() : 0 });
            }} />
          </Field>
        </>
      );
    }
    case 'stats': {
      const items = Array.isArray(cfg.items) ? (cfg.items as string[]) : [];
      const all = STAT_ITEMS[profileKind];
      const on = (k: string) => !items.length || items.includes(k);
      const toggle = (k: string) => {
        const cur = items.length ? items : all.map((x) => x.key);
        const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
        set({ items: all.map((x) => x.key).filter((x) => next.includes(x)) });
      };
      return (
        <Field label="显示哪几项" hint="连续在线天数从这次更新以后开始算">
          <div className="flex flex-wrap gap-2">
            {all.map((x) => (
              <button key={x.key} onClick={() => toggle(x.key)} aria-pressed={on(x.key)} className={cx('press rounded-xl px-3 py-1.5 text-[0.88rem]', on(x.key) ? 'bg-accent text-white' : 'bg-black/[0.05] dark:bg-white/10')}>
                {x.label}
              </button>
            ))}
          </div>
        </Field>
      );
    }
    case 'guestbook':
      return <Field label="标题"><Input value={str(cfg.title)} maxLength={30} onChange={(e) => set({ title: e.target.value })} /></Field>;
    case 'music': {
      const id = str(cfg.playlist_id);
      return (
        <>
          <Field label="网易云歌单链接" hint={id ? `歌单 ID：${id}` : '在网易云里点歌单的「分享 → 复制链接」，粘贴到这里'}>
            <Input defaultValue={id ? `https://music.163.com/#/playlist?id=${id}` : ''} placeholder="https://music.163.com/#/playlist?id=…" onChange={(e) => set({ playlist_id: neteasePlaylistId(e.target.value) })} />
          </Field>
          <Field label="标题"><Input value={str(cfg.title)} maxLength={40} placeholder="例如：最近单曲循环" onChange={(e) => set({ title: e.target.value })} /></Field>
          <p className="text-[0.8rem] text-ink-soft dark:text-white/45">用的是网易云官方的外链播放器，别人点一下才会加载。有版权保护的歌单网易云可能不让外链播放。</p>
        </>
      );
    }
    default:
      return <p className="text-ink-soft dark:text-white/55">这个小组件没有要设置的内容。</p>;
  }
}

/** Pick / reorder / remove images (uploads right away). */
function ImagePick({ ids, max, onChange }: { ids: string[]; max: number; onChange: (ids: string[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (files: FileList) => {
    setBusy(true);
    try {
      const got = await uploadImages(Array.from(files).slice(0, max - (max === 1 ? 0 : ids.length)));
      onChange(max === 1 ? got.slice(0, 1) : [...ids, ...got].slice(0, max));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const move = (i: number, d: number) => {
    const next = [...ids];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {ids.map((id, i) => (
          <div key={id + i} className="group relative h-20 w-20">
            <Thumb id={id} className="h-full w-full" />
            <div className="absolute inset-x-0 bottom-0 flex justify-between p-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              {max > 1 && i > 0 ? <button onClick={() => move(i, -1)} aria-label="往前" className="rounded bg-black/50 p-0.5 text-white"><ArrowLeft size={13} /></button> : <span />}
              <button onClick={() => onChange(ids.filter((_, n) => n !== i))} aria-label="移除" className="rounded bg-black/50 p-0.5 text-white"><X size={13} /></button>
              {max > 1 && i < ids.length - 1 ? <button onClick={() => move(i, 1)} aria-label="往后" className="rounded bg-black/50 p-0.5 text-white"><ArrowRight size={13} /></button> : <span />}
            </div>
          </div>
        ))}
        {(max === 1 || ids.length < max) && (
          <button onClick={() => ref.current?.click()} disabled={busy} className="press flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-black/15 text-[0.75rem] text-ink-soft dark:border-white/15 dark:text-white/50">
            {busy ? <Spinner size={18} /> : <ImagePlus size={20} />}
            {max === 1 ? (ids.length ? '换一张' : '选图片') : '加照片'}
          </button>
        )}
      </div>
      {max > 1 && <p className="mt-1.5 text-[0.78rem] text-ink-soft dark:text-white/45">{ids.length} / {max} 张，可以一次选多张</p>}
      <input ref={ref} type="file" accept="image/*" multiple={max > 1} hidden onChange={(e) => { if (e.target.files?.length) pick(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

/** Picker of widget kinds that fit this profile. */
export function AddWidgetDialog({ open, profileKind, onClose, onPick }: { open: boolean; profileKind: ProfileKind; onClose: () => void; onPick: (k: KindInfo) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="添加小组件" width={560}>
      <div className="grid max-h-[60vh] grid-cols-2 gap-2.5 overflow-y-auto pr-1">
        {KINDS.filter((k) => !k.only || k.only === profileKind).map((k) => (
          <button key={k.kind} onClick={() => onPick(k)} className="lift flex items-start gap-3 rounded-2xl bg-black/[0.03] p-3 text-left hover:bg-accent-50 dark:bg-white/[0.04] dark:hover:bg-white/10">
            <span className="text-[1.6rem] leading-none">{k.emoji}</span>
            <span className="min-w-0">
              <span className="block font-medium">{k.label}</span>
              <span className="block text-[0.8rem] text-ink-soft dark:text-white/50">{k.desc}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[0.8rem] text-ink-soft dark:text-white/45">工坊里的小组件以后会出现在这里。</p>
    </Dialog>
  );
}

/** Profile background: default, gradient preset, colour or picture (blur / darken). */
export function BackgroundDialog({ open, value, onClose, onApply }: { open: boolean; value: Background; onClose: () => void; onApply: (b: Background) => void }) {
  const [bg, setBg] = useState(value);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) setBg(value); }, [open, value]);
  const pick = async (f: File) => {
    setBusy(true);
    try {
      const [id] = await uploadImages([f]);
      setBg((b) => ({ ...b, kind: 'image', mediaId: id, blur: b.kind === 'image' ? b.blur : 8, dim: b.kind === 'image' ? b.dim : 20 }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="主页背景" width={520}>
      <div className="space-y-4">
        <Segmented
          id="bg-kind"
          value={bg.kind || 'none'}
          onChange={(k) => setBg((b) => ({ ...b, kind: k === 'none' ? '' : (k as Background['kind']), value: k === 'gradient' ? (GRADIENTS[b.value] ? b.value : 'sakura') : k === 'color' ? (/^#/.test(b.value) ? b.value : '#f7d6e6') : b.value }))}
          options={[{ value: 'none', label: '默认' }, { value: 'gradient', label: '渐变' }, { value: 'color', label: '纯色' }, { value: 'image', label: '图片' }]}
        />
        {bg.kind === 'gradient' && (
          <div className="grid grid-cols-6 gap-2">
            {Object.entries(GRADIENTS).map(([name, [a, b]]) => (
              <button key={name} onClick={() => setBg({ ...bg, value: name })} aria-label={name} aria-pressed={bg.value === name}
                className={cx('press aspect-square rounded-2xl ring-offset-2 ring-offset-transparent', bg.value === name && 'ring-2 ring-accent')}
                style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} />
            ))}
          </div>
        )}
        {bg.kind === 'color' && (
          <Field label="颜色"><input type="color" value={bg.value || '#f7d6e6'} onChange={(e) => setBg({ ...bg, value: e.target.value })} className="h-11 w-24 cursor-pointer rounded-xl border-0 bg-transparent" /></Field>
        )}
        {bg.kind === 'image' && (
          <>
            <div className="flex items-center gap-3">
              {bg.mediaId && <Thumb id={bg.mediaId} className="h-20 w-32" />}
              <Button variant="soft" loading={busy} onClick={() => ref.current?.click()}><ImagePlus size={15} /> {bg.mediaId ? '换一张' : '选图片'}</Button>
              <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
            </div>
            <Field label={`模糊：${bg.blur}`}><Slider label="模糊" value={bg.blur} min={0} max={40} step={1} onChange={(v) => setBg({ ...bg, blur: v })} /></Field>
            <Field label={`变暗：${bg.dim}%`}><Slider label="变暗" value={bg.dim} min={0} max={80} step={5} onChange={(v) => setBg({ ...bg, dim: v })} /></Field>
          </>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={bg.kind === 'image' && !bg.mediaId} onClick={() => { onApply(bg); onClose(); }}>好了</Button>
      </div>
    </Dialog>
  );
}
