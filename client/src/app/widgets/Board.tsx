// A profile's widget board (docs/design.md §7): up to 3 pages, 6 x 4 cells in
// landscape (desktop) and 4 x 6 in portrait (phone). Viewers see only pages
// that have widgets and can swipe between them. Editors drag widgets to any
// free cell; the portrait board follows the landscape one until it is
// arranged by hand. Everything is saved at once ("保存"), as a new version.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, LayoutGrid, Monitor, Paintbrush, Pencil, Plus, RefreshCw, Settings2, Smartphone, Wand2, X } from 'lucide-react';
import { ApiError } from '@/lib/errors';
import { current } from '@/lib/store';
import type { ProfileData, ProfileTarget, SessionView } from '@/lib/session';
import type { User } from '@/lib/types';
import { GRADIENTS, kindInfo, type KindInfo, type ProfileKind } from '@/lib/widgetKinds';
import {
  GRID, MAX_PAGES, cellAt, firstFree, fits, freezePortrait, placements, usedPages,
  type Background, type Cell, type LayoutModel, type Orientation, type WidgetModel,
} from '@/lib/widgets';
import { Button, IconButton, Segmented, cx, spring, toast, toastError } from '@/ui';
import { useMediaUrl, mediaPath } from '../media';
import { AddWidgetDialog, BackgroundDialog, WidgetEditor, type EditTarget } from './Editor';
import { WidgetView, type WidgetCtx } from './Kinds';

const GAP = 12;
/** Largest cell in px, so a wide window doesn't blow the board up. */
const MAX_CELL = 132;

function useScreenOrientation(): Orientation {
  const q = '(orientation: portrait)';
  const [o, setO] = useState<Orientation>(() => (window.matchMedia(q).matches ? 'portrait' : 'landscape'));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setO(m.matches ? 'portrait' : 'landscape');
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return o;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Moves a widget to `cell` in one orientation (fixing the portrait board first if needed). */
function setCell(l: LayoutModel, id: string, o: Orientation, cell: Cell): LayoutModel {
  if (o === 'landscape') return { ...l, widgets: l.widgets.map((w) => (w.id === id ? { ...w, land: cell } : w)) };
  const f = freezePortrait(l);
  return { ...f, widgets: f.widgets.map((w) => (w.id === id ? { ...w, port: cell } : w)) };
}

/** A spot for a w x h widget: keep `keep` if it still fits, else the first free one (on `page` only, if given). */
function spot(l: LayoutModel, o: Orientation, id: string, w: number, h: number, keep?: Cell, page?: number): Cell | null {
  const others = l.widgets.filter((x) => x.id !== id);
  const pl = placements({ ...l, widgets: others }, o);
  if (keep && (page === undefined || keep.page === page) && fits(others, pl, o, keep, w, h)) return keep;
  const c = firstFree(others, pl, o, w, h, page ?? keep?.page ?? 0);
  return c && (page === undefined || c.page === page) ? c : null;
}

export function Board({ v, target, profileKind, data, owner, onChange, reload, onBackground }: {
  v: SessionView;
  target: ProfileTarget;
  profileKind: ProfileKind;
  data: ProfileData;
  owner?: User;
  onChange: (d: ProfileData) => void;
  reload: () => void;
  /** The background being edited (null = not editing), for the page to preview. */
  onBackground?: (b: Background | null) => void;
}) {
  const screen = useScreenOrientation();
  const [mode, setMode] = useState<'view' | 'layout' | 'content'>('view');
  const [draft, setDraft] = useState<LayoutModel>(data.layout);
  const [preview, setPreview] = useState<Orientation>(screen);
  const [pageIdx, setPageIdx] = useState(0);
  const [dir, setDir] = useState(1);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const [bgOpen, setBgOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const dragStart = useRef<{ id: string; x: number; y: number } | null>(null);
  const [boxRef, width] = useWidth<HTMLDivElement>();

  const edit = mode !== 'view';
  const layout = edit ? draft : data.layout;
  const o: Orientation = edit ? preview : screen;
  const g = GRID[o];
  const cell = width ? Math.min(o === 'portrait' ? 101 : MAX_CELL, (width - GAP * (g.cols - 1)) / g.cols) : 0;
  const boardW = g.cols * cell + (g.cols - 1) * GAP;
  const pitch = cell + GAP;
  const pl = useMemo(() => placements(layout, o), [layout, o]);
  const used = usedPages(pl);
  const pages = edit ? Array.from({ length: Math.max(MAX_PAGES, (used.at(-1) ?? 0) + 1) }, (_, i) => i) : used;
  const idx = Math.min(pageIdx, Math.max(0, pages.length - 1));
  const page = pages[idx] ?? 0;
  const canLayout = mode === 'layout';
  const editable = new Set(data.editable);

  useEffect(() => {
    if (!edit) setDraft(data.layout);
  }, [data.layout, edit]);
  useEffect(() => {
    onBackground?.(edit ? draft.background : null);
  }, [edit, draft.background, onBackground]);

  const go = (i: number) => {
    if (i < 0 || i >= pages.length) return;
    setDir(i > idx ? 1 : -1);
    setPageIdx(i);
  };

  const start = (m: 'layout' | 'content') => {
    setDraft(data.layout);
    setPreview(screen);
    setMode(m);
  };

  async function save() {
    setSaving(true);
    try {
      const d = await current().saveProfile(target, draft);
      onChange(d);
      setMode('view');
      toast('主页已保存');
    } catch (e) {
      toastError(e);
      if (e instanceof ApiError && e.code === 'layout_conflict') {
        setMode('view');
        reload();
      }
    } finally {
      setSaving(false);
    }
  }

  function add(k: KindInfo) {
    setAdding(false);
    const id = newId();
    const land = spot(draft, 'landscape', id, k.w, k.h, undefined, o === 'landscape' ? page : undefined) ?? spot(draft, 'landscape', id, k.w, k.h);
    const port = draft.portraitCustom
      ? spot(draft, 'portrait', id, k.w, k.h, undefined, o === 'portrait' ? page : undefined) ?? spot(draft, 'portrait', id, k.w, k.h) ?? undefined
      : undefined;
    if (!land || (draft.portraitCustom && !port)) {
      toast('三页都放满了，先删掉一些或者改小一点', true);
      return;
    }
    const w: WidgetModel = { id, kind: k.kind, source: 'builtin', w: k.w, h: k.h, land, port, config: k.config(), contentEditors: 'everyone' };
    const next = { ...draft, widgets: [...draft.widgets, w] };
    setDraft(next);
    const p = (o === 'landscape' ? land : port ?? placements(next, 'portrait').get(id))?.page ?? page;
    go(pages.indexOf(p));
    if (!['status', 'online'].includes(k.kind)) setEditing({ widget: w, layout: true, content: true, editors: data.canSetEditors });
  }

  function applyEdit(w: WidgetModel, move: { size?: [number, number]; page?: number }): boolean {
    let next: LayoutModel = { ...draft, widgets: draft.widgets.map((x) => (x.id === w.id ? w : x)) };
    if (move.size || move.page !== undefined) {
      const [nw, nh] = move.size ?? [w.w, w.h];
      const cur = pl.get(w.id);
      const here = spot(next, o, w.id, nw, nh, cur, move.page ?? cur?.page);
      const other: Orientation = o === 'landscape' ? 'portrait' : 'landscape';
      const otherCell = other === 'landscape' ? w.land : w.port;
      const there = other === 'portrait' && !next.portraitCustom ? null : spot(next, other, w.id, nw, nh, otherCell);
      if (!here || (other === 'landscape' && !there) || (other === 'portrait' && next.portraitCustom && !there)) {
        toast('那里放不下这么大的小组件，换一页或者先挪开别的', true);
        return false;
      }
      next = { ...next, widgets: next.widgets.map((x) => (x.id === w.id ? { ...x, w: nw, h: nh } : x)) };
      next = setCell(next, w.id, o, here);
      if (there) next = setCell(next, w.id, other, there);
      go(pages.indexOf(here.page));
    }
    setDraft(next);
    return true;
  }

  // ---- dragging (layout editors) ----
  const onDown = (e: React.PointerEvent, w: WidgetModel) => {
    if (!canLayout || e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, textarea, iframe')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { id: w.id, x: e.clientX, y: e.clientY };
    setDrag({ id: w.id, dx: 0, dy: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    const s = dragStart.current;
    if (s) setDrag({ id: s.id, dx: e.clientX - s.x, dy: e.clientY - s.y });
  };
  const dropTarget = (w: WidgetModel): { cell: Cell; ok: boolean } | null => {
    const c = pl.get(w.id);
    if (!drag || drag.id !== w.id || !c || !pitch) return null;
    const cellTo = cellAt(o, page, c.x * pitch + drag.dx, c.y * pitch + drag.dy, pitch, w.w, w.h);
    return { cell: cellTo, ok: fits(layout.widgets, pl, o, cellTo, w.w, w.h, w.id) };
  };
  const onUp = (w: WidgetModel) => {
    const t = dropTarget(w);
    const moved = drag && Math.hypot(drag.dx, drag.dy) > 4;
    dragStart.current = null;
    setDrag(null);
    if (t && moved && t.ok) setDraft((d) => setCell(d, w.id, o, t.cell));
  };

  const ctx: WidgetCtx = { v, target, profileKind, data, owner, editing: edit };
  const boardH = g.rows * cell + (g.rows - 1) * GAP;
  const dragging = drag ? layout.widgets.find((w) => w.id === drag.id) : undefined;
  const ghost = dragging ? dropTarget(dragging) : null;

  return (
    <div ref={boxRef} className="mt-8 w-full">
      <div className="mx-auto" style={{ maxWidth: boardW || undefined }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex-1">
          <h2 className="inline-flex items-center gap-2 rounded-xl bg-white/70 px-3 py-1 text-[1.05rem] font-semibold backdrop-blur dark:bg-black/30">
            <LayoutGrid size={18} className="text-accent" /> 主页
          </h2>
        </div>
        {mode === 'view' ? (
          <>
            <IconButton label="刷新主页" onClick={reload}><RefreshCw size={16} /></IconButton>
            {data.canEditLayout && <Button variant="soft" size="sm" onClick={() => start('layout')}><Pencil size={14} /> 编辑主页</Button>}
            {!data.canEditLayout && data.editable.length > 0 && <Button variant="soft" size="sm" onClick={() => start('content')}><Pencil size={14} /> 编辑小组件内容</Button>}
          </>
        ) : (
          <>
            <Segmented id="board-orientation" value={preview} onChange={setPreview} options={[
              { value: 'landscape', label: <span className="flex items-center gap-1"><Monitor size={14} /> 横屏</span> },
              { value: 'portrait', label: <span className="flex items-center gap-1"><Smartphone size={14} /> 竖屏</span> },
            ]} />
            {canLayout && (
              <>
                <Button variant="soft" size="sm" onClick={() => setAdding(true)}><Plus size={15} /> 添加</Button>
                <Button variant="soft" size="sm" onClick={() => setBgOpen(true)}><Paintbrush size={14} /> 背景</Button>
              </>
            )}
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setMode('view')}>取消</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={save}>保存</Button>
          </>
        )}
      </div>
      {edit && (
        <p className="mb-3 rounded-xl bg-white/60 px-3 py-1.5 text-[0.8rem] text-ink-soft backdrop-blur dark:bg-black/25 dark:text-white/60">
          {canLayout ? '拖动小组件换位置（可以留空），点 ⚙ 改内容、大小和页数。' : '点 ⚙ 改小组件里的内容。'}
          {preview === 'portrait' && (layout.portraitCustom ? ' 竖屏是你手动摆的。' : ' 竖屏现在按横屏的顺序自动排，在这里挪动后就按你摆的来。')}
          {canLayout && preview === 'portrait' && layout.portraitCustom && (
            <button onClick={() => setDraft({ ...draft, portraitCustom: false, widgets: draft.widgets.map((w) => ({ ...w, port: undefined })) })} className="ml-1 inline-flex items-center gap-1 text-accent-700 hover:underline dark:text-accent-200">
              <Wand2 size={13} /> 竖屏重新自动排
            </button>
          )}
        </p>
      )}

      <div className="relative">
        {!pages.length && (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-3xl border-2 border-dashed border-black/10 p-6 text-center text-ink-soft dark:border-white/10 dark:text-white/45">
            还没有小组件{data.canEditLayout ? '，点「编辑主页」添加' : ''}
          </div>
        )}
        {cell > 0 && pages.length > 0 && (
          <div className="relative mx-auto" style={{ height: boardH, width: boardW }}>
            <AnimatePresence initial={false} custom={dir} mode="popLayout">
              <motion.div
                key={`${o}-${page}`}
                custom={dir}
                initial={{ opacity: 0, x: dir * 60 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -dir * 60 }}
                transition={spring}
                className="absolute inset-0"
                drag={edit ? false : 'x'}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.18}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -70) go(idx + 1);
                  else if (info.offset.x > 70) go(idx - 1);
                }}
              >
                {edit && (
                  <div className="pointer-events-none absolute inset-0 grid gap-3" style={{ gridTemplateColumns: `repeat(${g.cols}, 1fr)`, gridTemplateRows: `repeat(${g.rows}, 1fr)` }}>
                    {Array.from({ length: g.cols * g.rows }, (_, i) => <div key={i} className="rounded-[22px] border-2 border-dashed border-black/[0.06] dark:border-white/[0.07]" />)}
                  </div>
                )}
                {ghost && (
                  <div
                    className={cx('absolute rounded-[22px] border-2 border-dashed', ghost.ok ? 'border-emerald-400 bg-emerald-400/10' : 'border-rose-400 bg-rose-400/10')}
                    style={{ left: ghost.cell.x * pitch, top: ghost.cell.y * pitch, width: dragging!.w * cell + (dragging!.w - 1) * GAP, height: dragging!.h * cell + (dragging!.h - 1) * GAP }}
                  />
                )}
                {layout.widgets.map((w) => {
                  const c = pl.get(w.id);
                  if (!c || c.page !== page) return null;
                  const isDrag = drag?.id === w.id;
                  const canGear = canLayout || editable.has(w.id);
                  return (
                    <motion.div
                      key={w.id}
                      initial={false}
                      animate={{ left: c.x * pitch, top: c.y * pitch, width: w.w * cell + (w.w - 1) * GAP, height: w.h * cell + (w.h - 1) * GAP }}
                      transition={spring}
                      style={{ x: isDrag ? drag.dx : 0, y: isDrag ? drag.dy : 0, zIndex: isDrag ? 20 : 1, touchAction: canLayout ? 'none' : undefined }}
                      className={cx('absolute', canLayout && 'cursor-grab', isDrag && 'cursor-grabbing')}
                      onPointerDown={(e) => onDown(e, w)}
                      onPointerMove={onMove}
                      onPointerUp={() => onUp(w)}
                      onPointerCancel={() => { dragStart.current = null; setDrag(null); }}
                    >
                      <motion.div
                        className={cx('card relative h-full w-full overflow-hidden rounded-[22px] bg-white/90 dark:bg-[#26213f]/90', isDrag && 'shadow-2xl')}
                        animate={edit && !isDrag ? { rotate: [-0.5, 0.5, -0.5] } : { rotate: 0 }}
                        transition={edit && !isDrag ? { duration: 0.42, repeat: Infinity, ease: 'easeInOut', delay: (w.id.charCodeAt(0) % 7) * 0.05 } : spring}
                      >
                        <WidgetView w={w} ctx={ctx} />
                        {edit && <div className="absolute inset-0" />}
                        {edit && (
                          <div className="absolute top-1.5 right-1.5 z-10 flex gap-1">
                            {canGear && (
                              <button
                                onClick={() => setEditing({ widget: w, layout: canLayout, content: canLayout || editable.has(w.id), editors: data.canSetEditors && profileKind === 'server' })}
                                aria-label={`设置 ${kindInfo(w.kind)?.label ?? w.kind}`}
                                className="press flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-ink shadow dark:bg-black/60 dark:text-white"
                              >
                                <Settings2 size={14} />
                              </button>
                            )}
                            {canLayout && (
                              <button
                                onClick={() => setDraft((d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== w.id) }))}
                                aria-label={`删除 ${kindInfo(w.kind)?.label ?? w.kind}`}
                                className="press flex h-7 w-7 items-center justify-center rounded-full bg-rose-500 text-white shadow"
                              >
                                <X size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </motion.div>
                    </motion.div>
                  );
                })}
              </motion.div>
            </AnimatePresence>
          </div>
        )}
        {pages.length > 1 && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <IconButton label="上一页" disabled={idx === 0} onClick={() => go(idx - 1)}><ChevronLeft size={18} /></IconButton>
            <div className="flex gap-1.5">
              {pages.map((p, i) => (
                <button key={p} onClick={() => go(i)} aria-label={`第 ${p + 1} 页`} aria-current={i === idx || undefined}
                  className={cx('h-2 rounded-full transition-all duration-300 ease-[var(--ease-out)]', i === idx ? 'w-6 bg-accent' : 'w-2 bg-black/15 dark:bg-white/20')} />
              ))}
            </div>
            <IconButton label="下一页" disabled={idx >= pages.length - 1} onClick={() => go(idx + 1)}><ChevronRight size={18} /></IconButton>
          </div>
        )}
      </div>

      </div>
      <WidgetEditor
        target={editing}
        profileKind={profileKind}
        page={editing ? pl.get(editing.widget.id)?.page ?? page : page}
        onClose={() => setEditing(null)}
        onApply={applyEdit}
      />
      <AddWidgetDialog open={adding} profileKind={profileKind} onClose={() => setAdding(false)} onPick={add} />
      <BackgroundDialog open={bgOpen} value={draft.background} onClose={() => setBgOpen(false)} onApply={(b) => setDraft({ ...draft, background: b })} />
    </div>
  );
}

/** A profile's custom background, behind the whole page. */
export function ProfileBg({ bg }: { bg: Background }) {
  const url = useMediaUrl(bg.kind === 'image' && bg.mediaId ? mediaPath(bg.mediaId) : undefined);
  if (!bg.kind) return null;
  let style: React.CSSProperties = {};
  if (bg.kind === 'color') style = { background: bg.value };
  else if (bg.kind === 'gradient') {
    const [a, b] = GRADIENTS[bg.value] ?? GRADIENTS.sakura;
    style = { background: `linear-gradient(135deg, ${a}, ${b})` };
  }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl" style={style}>
      {bg.kind === 'image' && url && (
        <img src={url} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover" style={{ filter: `blur(${bg.blur}px)` }} />
      )}
      {bg.kind === 'image' && <div className="absolute inset-0 bg-black" style={{ opacity: bg.dim / 100 }} />}
    </div>
  );
}
