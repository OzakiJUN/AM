// Stickers (docs/design.md §11): the panel in the composer and the manager
// where pictures are imported in bulk and tagged by hand. Automatic
// recognition will fill the tags later; its button is already there.
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Search, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { importStickers, loadStickers, removeSticker, setTags, useStickers } from '@/lib/stickers';
import { parseTags, searchStickers, tagsText } from '@/lib/stickerTags';
import type { Sticker } from '@/lib/session';
import { Button, Dialog, Empty, Input, Spinner, cx, toast, toastError } from '@/ui';
import { mediaPath, useMediaUrl } from './media';

function Pic({ id, className }: { id: string; className?: string }) {
  const url = useMediaUrl(mediaPath(id, true));
  return <span className={cx('block', className)}>{url && <img src={url} alt="" className="h-full w-full object-contain" draggable={false} />}</span>;
}

/** The grid that pops up from the composer: search by tag, click to send. */
export function StickerPanel({ serverId, onSend, onManage }: { serverId: string; onSend: (s: Sticker) => void; onManage: () => void }) {
  const list = useStickers((s) => s.byServer[serverId]);
  const [q, setQ] = useState('');
  useEffect(() => {
    void loadStickers(serverId).catch(toastError);
  }, [serverId]);
  const shown = list ? searchStickers(list, q) : [];
  return (
    <div className="w-[22rem]">
      <div className="flex items-center gap-2 p-1">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-soft" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按标签找" aria-label="按标签找表情"
            className="h-8 w-full rounded-lg bg-black/[0.04] pr-2 pl-8 text-[0.85rem] outline-none dark:bg-white/[0.06]" />
        </div>
        <button onClick={onManage} aria-label="管理表情" title="导入、改标签" className="press rounded-lg p-1.5 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><Settings2 size={16} /></button>
      </div>
      {!list ? (
        <div className="flex justify-center py-6 text-ink-soft"><Spinner /></div>
      ) : !list.length ? (
        <div className="p-4 text-center text-[0.85rem] text-ink-soft dark:text-white/50">
          还没有表情。<button onClick={onManage} className="text-accent underline">批量导入</button>
        </div>
      ) : (
        <div className="grid max-h-64 grid-cols-5 gap-1 overflow-y-auto p-1">
          {shown.map((s) => (
            <button key={s.id} onClick={() => onSend(s)} title={tagsText(s.tags) || '没有标签'} aria-label={`发表情 ${tagsText(s.tags) || s.id}`}
              className="press aspect-square rounded-xl p-1 hover:bg-accent-50 dark:hover:bg-white/10">
              <Pic id={s.mediaId} className="h-full w-full" />
            </button>
          ))}
          {!shown.length && <p className="col-span-5 py-4 text-center text-[0.85rem] text-ink-soft">没有这个标签的表情</p>}
        </div>
      )}
    </div>
  );
}

function TagEdit({ serverId, s }: { serverId: string; s: Sticker }) {
  const [text, setText] = useState(tagsText(s.tags));
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(tagsText(s.tags)), [s.tags]);
  const save = async () => {
    const tags = parseTags(text);
    if (tagsText(tags) === tagsText(s.tags)) return setText(tagsText(tags));
    setBusy(true);
    try {
      await setTags(serverId, s.id, tags);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      placeholder="填标签：开心 狗头" aria-label="表情标签" disabled={busy}
      className={cx('h-8 w-full min-w-0 rounded-lg bg-black/[0.04] px-2 text-[0.8rem] outline-none focus:ring-2 focus:ring-accent/40 dark:bg-white/[0.06]', !s.tags.length && 'ring-1 ring-amber-300/70')} />
  );
}

/** Import in bulk, tag by hand, delete. */
export function StickerManager({ serverId, open, onClose }: { serverId: string; open: boolean; onClose: () => void }) {
  const list = useStickers((s) => s.byServer[serverId]);
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [untagged, setUntagged] = useState(false);
  useEffect(() => {
    if (open) void loadStickers(serverId).catch(toastError);
  }, [open, serverId]);
  const pick = async (files: File[]) => {
    setBusy(`上传中 0/${files.length}`);
    try {
      const n = await importStickers(serverId, files, (d) => setBusy(`上传中 ${d}/${files.length}`));
      toast(`导入了 ${n} 个表情，记得填标签`);
      setUntagged(true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };
  const all = list ?? [];
  const shown = searchStickers(untagged ? all.filter((s) => !s.tags.length) : all, q);
  return (
    <Dialog open={open} onClose={onClose} title="我的表情" width={640}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!!busy} onClick={() => ref.current?.click()}>{busy ? <Spinner size={15} /> : <ImagePlus size={16} />} {busy || '批量导入'}</Button>
        <Button variant="soft" disabled title="还没上线：以后会自动认出图里的文字和内容，帮你填标签"><Sparkles size={16} /> 自动识别标签</Button>
        <div className="flex-1" />
        <div className="w-40"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按标签找" aria-label="按标签找" className="h-9" /></div>
        <button onClick={() => setUntagged((u) => !u)} aria-pressed={untagged}
          className={cx('press rounded-xl px-3 py-1.5 text-[0.85rem]', untagged ? 'bg-accent text-white' : 'bg-black/[0.05] dark:bg-white/10')}>
          没标签的（{all.filter((s) => !s.tags.length).length}）
        </button>
      </div>
      <p className="mt-2 text-[0.8rem] text-ink-soft dark:text-white/45">
        一次可以选很多张图。标签用空格或逗号分开，按标签搜；发给 AI 时它看到的是标签。没填标签的表情发出去就是普通图片。「自动识别标签」还没上线。
      </p>
      <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void pick(f); }} />
      <div className="mt-3 max-h-[52vh] overflow-y-auto pr-1">
        {!list ? (
          <div className="flex justify-center py-10 text-ink-soft"><Spinner /></div>
        ) : !shown.length ? (
          <Empty icon={<ImagePlus size={26} />} title={all.length ? '没有符合的表情' : '还没有表情'} text={all.length ? undefined : '点「批量导入」，一次选好多张图'} />
        ) : (
          <div className="grid grid-cols-4 gap-2.5">
            {shown.map((s) => (
              <div key={s.id} className="group relative flex flex-col gap-1.5 rounded-2xl bg-black/[0.03] p-2 dark:bg-white/[0.04]">
                <Pic id={s.mediaId} className="aspect-square w-full" />
                <TagEdit serverId={serverId} s={s} />
                <button onClick={() => removeSticker(serverId, s.id).catch(toastError)} aria-label="删掉这个表情"
                  className="absolute top-1.5 right-1.5 rounded-lg bg-white/90 p-1 text-ink-soft opacity-0 shadow transition-opacity duration-200 group-hover:opacity-100 hover:text-rose-500 dark:bg-black/60">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
