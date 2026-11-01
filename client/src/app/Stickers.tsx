// Stickers (docs/design.md §11): the panel in the composer (「我的」 = my
// collection, 「大家的」 = the server's shared library: search, send,
// collect, add tags) and the manager where pictures are imported in bulk,
// tagged by hand and marked private. Automatic recognition will fill the
// tags later; its button is already there.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, ImagePlus, Lock, Search, Settings2, Sparkles, Star, Tags, Trash2, X } from 'lucide-react';
import { collect, editLibraryTags, importStickers, loadStickers, removeSticker, setPrivate, setTags, useStickers } from '@/lib/stickers';
import { parseTags, searchStickers, tagsText } from '@/lib/stickerTags';
import type { LibrarySticker, Sticker } from '@/lib/session';
import { session, useApp } from '@/lib/store';
import { Button, Dialog, Empty, Input, Segmented, Spinner, cx, openMenu, toast, toastError, useBusy } from '@/ui';
import { mediaPath, useMediaUrl } from './media';

function Pic({ id, className }: { id: string; className?: string }) {
  const url = useMediaUrl(mediaPath(id, true));
  return <span className={cx('block', className)}>{url && <img src={url} alt="" className="h-full w-full object-contain" draggable={false} />}</span>;
}

/** A user's name on a server (fetched once when not known yet). */
function useUserName(serverId: string, id: string) {
  const v = useApp((st) => st.sessions[serverId]);
  useEffect(() => {
    if (id) session(serverId)?.wantUser(id);
  }, [serverId, id]);
  if (!id) return '';
  if (id === v?.me?.id) return '我';
  return v?.users[id]?.name ?? '';
}

function Uploader({ serverId, id, className }: { serverId: string; id: string; className?: string }) {
  const name = useUserName(serverId, id);
  if (!id) return null;
  return <span className={className}>最早：{name || '…'}</span>;
}

const isAdmin = (serverId: string) => !!useApp.getState().sessions[serverId]?.isAdmin;

/**
 * Tag chips: × on the ones I may take off (mine; a site admin: all), a box
 * to add more. onChange gets what to add and what to take off.
 */
function TagChips({ tags, mine, admin, onChange, compact }: {
  tags: string[]; mine: string[]; admin?: boolean; compact?: boolean;
  onChange: (add: string[], remove: string[]) => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const { busy, running, run } = useBusy();
  const own = new Set(mine.map((t) => t.toLowerCase()));
  const add = () => {
    const t = parseTags(text).filter((x) => !tags.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (!t.length) return setText('');
    if (running.current) return;
    run(onChange(t, []).then(() => setText('')));
  };
  return (
    <div className={cx('flex flex-wrap items-center gap-1', busy && 'opacity-60')}>
      {tags.map((t) => {
        const canRemove = admin || own.has(t.toLowerCase());
        return (
          <span key={t} className={cx('inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[0.75rem]', own.has(t.toLowerCase()) ? 'bg-accent-50 text-accent-700 dark:bg-white/10 dark:text-white' : 'bg-black/[0.05] text-ink-soft dark:bg-white/[0.06] dark:text-white/60')}
            title={own.has(t.toLowerCase()) ? '你加的' : '别人加的'}>
            {t}
            {canRemove && (
              <button disabled={busy} onClick={() => !running.current && run(onChange([], [t]))} aria-label={`去掉标签 ${t}`} className="press rounded-full p-0.5 hover:text-rose-500">
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={add} onKeyDown={(e) => e.key === 'Enter' && add()} disabled={busy}
        placeholder={tags.length ? '+ 标签' : '填标签：开心 狗头'} aria-label="加标签"
        className={cx('h-7 min-w-0 flex-1 rounded-lg bg-black/[0.04] px-2 text-[0.78rem] outline-none focus:ring-2 focus:ring-accent/40 dark:bg-white/[0.06]',
          compact ? 'basis-16' : 'basis-24', !tags.length && 'ring-1 ring-amber-300/70')} />
    </div>
  );
}

/** Tags of one of my stickers: shared ones edit the library's tags, private ones my own. */
function StickerTags({ serverId, s }: { serverId: string; s: Sticker }) {
  const change = (add: string[], remove: string[]) => {
    if (s.libraryId) {
      return editLibraryTags(serverId, { id: s.libraryId } as LibrarySticker, add, remove);
    }
    const lower = new Set(remove.map((t) => t.toLowerCase()));
    return setTags(serverId, s.id, [...s.tags.filter((t) => !lower.has(t.toLowerCase())), ...add]);
  };
  return <TagChips tags={s.tags} mine={s.myTags} admin={!!s.libraryId && isAdmin(serverId)} onChange={change} compact />;
}

// ---------- the panel in the composer ----------

type Tab = 'mine' | 'all';
let lastTab: Tab = 'mine';

/** The grid that pops up from the composer: search by tag, click to send. */
export function StickerPanel({ serverId, onSend, onManage }: { serverId: string; onSend: (s: { mediaId: string; tags: string[] }) => void; onManage: () => void }) {
  const [tab, setTab] = useState<Tab>(lastTab);
  const [q, setQ] = useState('');
  useEffect(() => {
    lastTab = tab;
  }, [tab]);
  return (
    <div className="w-[24rem]">
      <div className="flex items-center gap-2 p-1">
        <Segmented id="sticker-tab" value={tab} onChange={setTab} options={[{ value: 'mine', label: '我的' }, { value: 'all', label: '大家的' }]} />
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-soft" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按标签找" aria-label="按标签找表情"
            className="h-8 w-full rounded-lg bg-black/[0.04] pr-2 pl-8 text-[0.85rem] outline-none dark:bg-white/[0.06]" />
        </div>
        <button onClick={onManage} aria-label="管理表情" title="导入、改标签、公开 / 不公开" className="press rounded-lg p-1.5 text-ink-soft hover:bg-black/5 dark:hover:bg-white/10"><Settings2 size={16} /></button>
      </div>
      {tab === 'mine' ? <MineGrid serverId={serverId} q={q} onSend={onSend} onManage={onManage} /> : <LibraryGrid serverId={serverId} q={q} onSend={onSend} />}
    </div>
  );
}

function MineGrid({ serverId, q, onSend, onManage }: { serverId: string; q: string; onSend: (s: Sticker) => void; onManage: () => void }) {
  const list = useStickers((s) => s.byServer[serverId]);
  useEffect(() => {
    void loadStickers(serverId).catch(toastError);
  }, [serverId]);
  const shown = list ? searchStickers(list, q) : [];
  if (!list) return <div className="flex justify-center py-6 text-ink-soft"><Spinner /></div>;
  if (!list.length) {
    return (
      <div className="p-4 text-center text-[0.85rem] text-ink-soft dark:text-white/50">
        还没有表情。<button onClick={onManage} className="text-accent underline">批量导入</button>，或者去「大家的」里收藏。
      </div>
    );
  }
  return (
    <div className="grid max-h-64 grid-cols-5 gap-1 overflow-y-auto p-1">
      {shown.map((s) => (
        <button key={s.id} onClick={() => onSend(s)} title={tagsText(s.tags) || '没有标签'} aria-label={`发表情 ${tagsText(s.tags) || s.id}`}
          className="press aspect-square rounded-xl p-1 hover:bg-accent-50 dark:hover:bg-white/10">
          <Pic id={s.mediaId} className="h-full w-full" />
        </button>
      ))}
      {!shown.length && <p className="col-span-5 py-4 text-center text-[0.85rem] text-ink-soft">没有这个标签的表情</p>}
    </div>
  );
}

/** 「大家的」: the server's shared library. */
function LibraryGrid({ serverId, q, onSend }: { serverId: string; q: string; onSend: (s: { mediaId: string; tags: string[] }) => void }) {
  const [sort, setSort] = useState<'hot' | 'new'>('hot');
  const [items, setItems] = useState<LibrarySticker[] | null>(null);
  const [next, setNext] = useState(0);
  const [off, setOff] = useState(false);
  const [more, setMore] = useState(false);
  const [editing, setEditing] = useState<LibrarySticker | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (offset: number) => {
    const id = ++reqId.current;
    const r = await session(serverId)!.stickerLibrary(q.trim(), sort, offset);
    if (id !== reqId.current) return;
    setOff(r.disabled);
    setNext(r.next);
    setItems((cur) => (offset && cur ? [...cur, ...r.items.filter((x) => !cur.some((y) => y.id === x.id))] : r.items));
  }, [serverId, q, sort]);

  useEffect(() => {
    const t = setTimeout(() => void load(0).catch(toastError), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const replace = (x: LibrarySticker) => setItems((cur) => cur?.map((y) => (y.id === x.id ? x : y)) ?? null);
  const star = async (x: LibrarySticker) => {
    const st = await collect(serverId, x);
    replace({ ...x, mySticker: st.id, collectors: x.mySticker ? x.collectors : x.collectors + 1 });
    toast('收藏到「我的」了');
  };
  const loadMore = async () => {
    setMore(true);
    try {
      await load(next);
    } catch (e) {
      toastError(e);
    } finally {
      setMore(false);
    }
  };

  if (off) return <p className="p-4 text-center text-[0.85rem] text-ink-soft dark:text-white/50">这个服务器关掉了公共表情库。</p>;
  return (
    <>
      <div className="flex items-center justify-between px-1 pb-1">
        <Segmented id="sticker-sort" value={sort} onChange={setSort} options={[{ value: 'hot', label: '热门' }, { value: 'new', label: '最新' }]} />
        <span className="text-[0.72rem] text-ink-soft dark:text-white/40">点一下发出，☆ 收藏，右键补标签</span>
      </div>
      {!items ? (
        <div className="flex justify-center py-6 text-ink-soft"><Spinner /></div>
      ) : !items.length ? (
        <p className="p-4 text-center text-[0.85rem] text-ink-soft dark:text-white/50">{q ? '没有这个标签的表情' : '大家还没有加表情。你加进「我的」的表情会出现在这里。'}</p>
      ) : (
        <div className="max-h-64 overflow-y-auto p-1">
          <div className="grid grid-cols-5 gap-1">
            {items.map((x) => (
              <div key={x.id} className="group relative">
                <button onClick={() => onSend(x)} title={`${tagsText(x.tags) || '没有标签'} · ${x.collectors} 人收藏`} aria-label={`发表情 ${tagsText(x.tags) || x.id}`}
                  onContextMenu={(e) => openMenu(e, [
                    { label: x.mySticker ? '已经收藏了' : '收藏到「我的」', icon: <Star size={16} />, key: `collect:${x.id}`, onClick: () => (x.mySticker ? undefined : star(x)) },
                    { label: '补标签', icon: <Tags size={16} />, onClick: () => setEditing(x) },
                  ])}
                  className="press aspect-square w-full rounded-xl p-1 hover:bg-accent-50 dark:hover:bg-white/10">
                  <Pic id={x.mediaId} className="h-full w-full" />
                </button>
                <StarButton item={x} onStar={star} />
              </div>
            ))}
          </div>
          {next > 0 && (
            <div className="flex justify-center py-2">
              <Button size="sm" variant="ghost" loading={more} onClick={loadMore}>加载更多</Button>
            </div>
          )}
        </div>
      )}
      <LibraryTagDialog serverId={serverId} item={editing} onClose={() => setEditing(null)} onChanged={(x) => { replace(x); setEditing(x); }} />
    </>
  );
}

function StarButton({ item, onStar }: { item: LibrarySticker; onStar: (x: LibrarySticker) => Promise<void> }) {
  const { busy, running, run } = useBusy();
  const have = !!item.mySticker;
  return (
    <button disabled={busy || have} onClick={() => !running.current && run(onStar(item))} aria-label={have ? '已经收藏了' : '收藏'} title={have ? '已经在「我的」里' : '收藏到「我的」'}
      className={cx('absolute top-0.5 right-0.5 rounded-full bg-white/90 p-0.5 shadow transition-opacity duration-200 dark:bg-black/60',
        have ? 'text-amber-400 opacity-90' : 'text-ink-soft opacity-0 group-hover:opacity-100 hover:text-amber-500 focus-visible:opacity-100')}>
      {busy ? <Spinner size={12} /> : <Star size={12} fill={have ? 'currentColor' : 'none'} />}
    </button>
  );
}

/** Adding tags to a library picture (and seeing who uploaded it first). */
function LibraryTagDialog({ serverId, item, onClose, onChanged }: { serverId: string; item: LibrarySticker | null; onClose: () => void; onChanged: (x: LibrarySticker) => void }) {
  return (
    <Dialog open={!!item} onClose={onClose} title="补标签" width={380}>
      {item && (
        <div className="flex gap-3">
          <Pic id={item.mediaId} className="h-24 w-24 shrink-0 rounded-xl bg-black/[0.03] dark:bg-white/[0.04]" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-[0.8rem] text-ink-soft dark:text-white/50">
              <Uploader serverId={serverId} id={item.uploaderId} /> · {item.collectors} 人收藏
            </div>
            <TagChips tags={item.tags} mine={item.myTags} admin={isAdmin(serverId)} onChange={async (add, remove) => onChanged({ ...item, ...(await editLibraryTags(serverId, item, add, remove)) })} />
            <p className="text-[0.75rem] text-ink-soft dark:text-white/40">标签大家共用，帮别人更容易搜到。你只能去掉自己加的。</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------- the manager ----------

const HINT_KEY = 'am-sticker-library-hint';
function hintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return true;
  }
}

function PrivacyButton({ serverId, s }: { serverId: string; s: Sticker }) {
  const { busy, running, run } = useBusy();
  const shared = !s.private;
  return (
    <button disabled={busy} onClick={() => !running.current && run(setPrivate(serverId, s.id, shared).then((x) => toast(x.private ? '不公开了，只有你能看到' : '公开到「大家的」了')))}
      aria-label={shared ? '公开的，点一下改成不公开' : '不公开，点一下公开'} title={shared ? '公开：大家能在「大家的」里看到、收藏。点一下改成不公开' : '不公开：只有你自己有。点一下公开'}
      className={cx('press absolute top-1.5 left-1.5 rounded-lg bg-white/90 p-1 shadow dark:bg-black/60', shared ? 'text-accent' : 'text-ink-soft')}>
      {busy ? <Spinner size={14} /> : shared ? <Globe size={14} /> : <Lock size={14} />}
    </button>
  );
}

/** Import in bulk, tag by hand, private / shared, delete. */
export function StickerManager({ serverId, open, onClose }: { serverId: string; open: boolean; onClose: () => void }) {
  const list = useStickers((s) => s.byServer[serverId]);
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [q, setQ] = useState('');
  const [untagged, setUntagged] = useState(false);
  const [priv, setPriv] = useState(false);
  const [hint, setHint] = useState(!hintSeen());
  useEffect(() => {
    if (open) void loadStickers(serverId, true).catch(toastError);
  }, [open, serverId]);
  const pick = async (files: File[]) => {
    setBusy(`上传中 0/${files.length}`);
    try {
      const n = await importStickers(serverId, files, priv, (d) => setBusy(`上传中 ${d}/${files.length}`));
      toast(`导入了 ${n} 个表情，记得填标签`);
      setUntagged(true);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };
  const closeHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  };
  const all = list ?? [];
  const shown = searchStickers(untagged ? all.filter((s) => !s.tags.length) : all, q);
  return (
    <Dialog open={open} onClose={onClose} title="我的表情" width={680}>
      {hint && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-accent-50 p-3 text-[0.82rem] text-accent-700 dark:bg-white/10 dark:text-white/80">
          <Globe size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">你加的表情现在默认公开：会出现在大家的「大家的」里（同一张图只留一份，显示最早上传的人），标签大家一起补。不想公开的，点图左上角的小地球改成小锁。</span>
          <button onClick={closeHint} aria-label="知道了" className="press rounded p-0.5"><X size={14} /></button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!!busy} onClick={() => ref.current?.click()}>{busy ? <Spinner size={15} /> : <ImagePlus size={16} />} {busy || '批量导入'}</Button>
        <button onClick={() => setPriv((p) => !p)} aria-pressed={priv} title="这一批导入的表情只有你自己有，不进公共库"
          className={cx('press inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-[0.85rem]', priv ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-black/[0.05] dark:bg-white/10')}>
          <Lock size={14} /> 这批不公开
        </button>
        <Button variant="soft" disabled title="还没上线：以后会自动认出图里的文字和内容，帮你填标签"><Sparkles size={16} /> 自动识别标签</Button>
        <div className="flex-1" />
        <div className="w-36"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="按标签找" aria-label="按标签找" className="h-9" /></div>
        <button onClick={() => setUntagged((u) => !u)} aria-pressed={untagged}
          className={cx('press rounded-xl px-3 py-1.5 text-[0.85rem]', untagged ? 'bg-accent text-white' : 'bg-black/[0.05] dark:bg-white/10')}>
          没标签的（{all.filter((s) => !s.tags.length).length}）
        </button>
      </div>
      <p className="mt-2 text-[0.8rem] text-ink-soft dark:text-white/45">
        一次可以选很多张图。标签按回车或空格分开，按标签搜；发给 AI 时它看到的是标签。公开的表情标签大家共用，你只能去掉自己加的。会在后台慢慢复制到你的其他服务器（账号设置 → 资料同步）。
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
                <PrivacyButton serverId={serverId} s={s} />
                {s.libraryId && <Uploader serverId={serverId} id={s.uploaderId} className="truncate text-[0.7rem] text-ink-soft dark:text-white/40" />}
                <StickerTags serverId={serverId} s={s} />
                <DeleteButton serverId={serverId} s={s} />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function DeleteButton({ serverId, s }: { serverId: string; s: Sticker }) {
  const { busy, running, run } = useBusy();
  return (
    <button disabled={busy} onClick={() => !running.current && run(removeSticker(serverId, s.id))} aria-label="删掉这个表情" title="从我的表情里删掉（公开库里别人收藏的不受影响）"
      className="absolute top-1.5 right-1.5 rounded-lg bg-white/90 p-1 text-ink-soft opacity-0 shadow transition-opacity duration-200 group-hover:opacity-100 hover:text-rose-500 focus-visible:opacity-100 dark:bg-black/60">
      {busy ? <Spinner size={14} /> : <Trash2 size={14} />}
    </button>
  );
}
