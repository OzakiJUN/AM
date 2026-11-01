// The channel museum (docs/design.md §13 博物馆): the header button, the
// museum window (第一展厅 with 8 places, 第二展厅 = the most liked works of
// all public channels, 仓库, open votes) and the dialog for hanging a chat
// picture. The server decides whether a change needs a vote.
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeftRight, Check, EyeOff, Heart, Landmark, Undo2, Upload, X } from 'lucide-react';
import { create } from 'zustand';
import { session } from '@/lib/store';
import type { MuseumArt, MuseumResult, MuseumView, MuseumVote, SessionView } from '@/lib/session';
import type { Conversation } from '@/lib/types';
import { Button, Dialog, Field, IconButton, Input, Segmented, Spinner, Toggle, cx, openMenu, spring, toast } from '@/ui';
import { mediaPath, useMediaUrl } from './media';

const SLOTS = 8;
const MAX_TITLE = 12;

/** The museum window that is open (one at a time). */
const useMuseum = create<{ serverId: string; convId: string }>(() => ({ serverId: '', convId: '' }));
export const openMuseum = (serverId: string, convId: string) => useMuseum.setState({ serverId, convId });
const closeMuseum = () => useMuseum.setState({ serverId: '', convId: '' });

/** Header button + the window of this channel. */
export function MuseumButton({ v, conv }: { v: SessionView; conv: Conversation }) {
  const win = useMuseum();
  const open = win.serverId === v.id && win.convId === conv.id;
  return (
    <>
      <IconButton label="博物馆" active={open} onClick={() => openMuseum(v.id, conv.id)}><Landmark size={19} /></IconButton>
      <Dialog open={open} onClose={closeMuseum} title={`博物馆 · ${conv.name}`} width={760}>
        {open && <MuseumWindow v={v} conv={conv} />}
      </Dialog>
    </>
  );
}

/** Says what happened: done now, or a vote was started (the server words both). */
const told = (r: MuseumResult) => toast(r.text || (r.done ? '好了' : '发起了投票'));

type Tab = 'hall' | 'second' | 'store';

function MuseumWindow({ v, conv }: { v: SessionView; conv: Conversation }) {
  const [view, setView] = useState<MuseumView | null>(null);
  const [tab, setTab] = useState<Tab>('hall');
  const [pick, setPick] = useState<MuseumArt | null>(null);
  const [failed, setFailed] = useState('');
  // Reload whenever a museum line appears in the chat (votes, changes).
  const msgs = v.messages[conv.id];
  const stamp = useMemo(() => {
    for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
      const b = msgs![i].body;
      if (b.kind === 'system' && b.sys.t === 'museum') return msgs![i].id;
    }
    return '';
  }, [msgs]);
  const load = async () => {
    try {
      const r = await session(v.id)!.museum(conv.id);
      setView(r);
      setFailed('');
      setPick((p) => p && ([...r.hall, ...r.second, ...r.store].find((a) => a.id === p.id) ?? null));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id, conv.id, stamp]);

  if (failed && !view) return <p className="py-8 text-center text-ink-soft dark:text-white/50">{failed}</p>;
  if (!view) return <div className="flex justify-center py-10"><Spinner /></div>;
  const act = async (p: Promise<MuseumResult>) => {
    told(await p);
    await load();
  };
  const like = async (a: MuseumArt) => {
    const r = await session(v.id)!.museumLike(a.id, !a.liked);
    const put = (l: MuseumArt[]) => l.map((x) => (x.id === r.id ? { ...x, likes: r.likes, liked: r.liked } : x));
    setView((w) => w && { ...w, hall: put(w.hall), second: put(w.second), store: put(w.store) });
    setPick((p) => (p?.id === r.id ? { ...p, likes: r.likes, liked: r.liked } : p));
  };
  const list = tab === 'hall' ? view.hall : tab === 'second' ? view.second : view.store;
  return (
    <div className="space-y-3" data-testid="museum">
      {view.votes.length > 0 && (
        <div className="space-y-1.5">
          {view.votes.map((x) => <VoteRow key={x.id} v={v} vote={x} onVoted={load} />)}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Tab> id="museum-tab" value={tab} onChange={(t) => { setTab(t); setPick(null); }} options={[
          { value: 'hall', label: '第一展厅' },
          { value: 'second', label: '第二展厅' },
          { value: 'store', label: `仓库${view.store.length ? ` ${view.store.length}` : ''}` },
        ]} />
        <span className="text-[0.78rem] text-ink-soft dark:text-white/45">
          {tab === 'hall' && (view.needsVote ? `改动要全频道投票（${view.voteMinutes} 分钟，反对多于同意就不通过）` : '人不多，改动直接生效')}
          {tab === 'second' && '所有公开频道展厅里点赞最多的作品'}
          {tab === 'store' && '撤下来或被挤下来的作品'}
        </span>
      </div>
      {pick ? (
        <ArtView v={v} conv={conv} art={pick} tab={tab} view={view} onBack={() => setPick(null)} onLike={() => like(pick)} act={act} />
      ) : list.length === 0 ? (
        <p className="py-10 text-center text-ink-soft dark:text-white/50">
          {tab === 'second' ? '公开频道的展厅里还没有作品。' : tab === 'store' ? '仓库是空的。' : ''}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {list.map((a, i) => (
            <ArtCard key={a.id || `empty-${i}`} v={v} art={a} no={tab === 'hall' ? i + 1 : tab === 'second' ? i + 1 : 0}
              showConv={tab === 'second'} onOpen={() => setPick(a)} onLike={() => like(a)} />
          ))}
        </div>
      )}
      {tab === 'hall' && !pick && (
        <p className="text-[0.78rem] text-ink-soft dark:text-white/45">在聊天里右键图片 →「挂到博物馆」可以挂新作品。</p>
      )}
    </div>
  );
}

function Thumb({ v, art, full, className }: { v: SessionView; art: { mediaId: string; hidden?: boolean }; full?: boolean; className?: string }) {
  const url = useMediaUrl(art.mediaId ? mediaPath(art.mediaId, !full) : undefined, v.id);
  if (art.hidden) {
    return <div className={cx('flex flex-col items-center justify-center gap-1 bg-black/[0.06] text-[0.75rem] text-ink-soft dark:bg-white/[0.06] dark:text-white/50', className)}><EyeOff size={18} />NSFW</div>;
  }
  return url
    ? <img src={url} alt="作品" className={cx('object-cover', className)} draggable={false} />
    : <div className={cx('flex items-center justify-center bg-black/[0.04] dark:bg-white/[0.05]', className)}><Spinner /></div>;
}

const who = (v: SessionView, id: string) => (id === v.me?.id ? '我' : v.users[id]?.name ?? '某人');

function ArtCard({ v, art, no, showConv, onOpen, onLike }: { v: SessionView; art: MuseumArt; no: number; showConv: boolean; onOpen: () => void; onLike: () => Promise<void> }) {
  if (!art.id) {
    return (
      <div className="flex aspect-[3/4] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-black/10 text-[0.8rem] text-ink-soft dark:border-white/10 dark:text-white/40">
        <span className="font-medium">No.{no}</span>空位
      </div>
    );
  }
  return (
    <motion.div layout transition={spring} className="card lift press group relative flex aspect-[3/4] cursor-pointer flex-col overflow-hidden rounded-2xl" onClick={onOpen} data-testid="museum-art">
      <Thumb v={v} art={art} className="min-h-0 w-full flex-1" />
      <div className="flex items-center gap-1 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.85rem] font-medium">{no > 0 && <span className="mr-1 text-ink-soft dark:text-white/45">No.{no}</span>}《{art.title}》</div>
          <div className="truncate text-[0.72rem] text-ink-soft dark:text-white/45">{showConv ? `#${art.convName}` : `${who(v, art.byUserId)} · ${art.method}`}</div>
        </div>
        <LikeButton art={art} onLike={onLike} />
      </div>
    </motion.div>
  );
}

function LikeButton({ art, onLike }: { art: MuseumArt; onLike: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={art.liked ? '取消点赞' : '点赞'}
      aria-pressed={art.liked}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        setBusy(true);
        onLike().catch((err) => toast(err instanceof Error ? err.message : String(err), true)).finally(() => setBusy(false));
      }}
      className={cx('press flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 py-1 text-[0.78rem]', art.liked ? 'text-rose-500' : 'text-ink-soft hover:text-rose-500 dark:text-white/50')}
    >
      <Heart size={15} fill={art.liked ? 'currentColor' : 'none'} />{art.likes}
    </button>
  );
}

/** One work, big, with what I can do with it. */
function ArtView({ v, conv, art, tab, view, onBack, onLike, act }: {
  v: SessionView; conv: Conversation; art: MuseumArt; tab: Tab; view: MuseumView;
  onBack: () => void; onLike: () => Promise<void>; act: (p: Promise<MuseumResult>) => Promise<void>;
}) {
  const s = session(v.id)!;
  const own = art.convId === conv.id;
  const slotMenu = (e: React.MouseEvent, title: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    const empty = view.hall.some((a) => !a.id);
    openMenu({ clientX: r.left, clientY: r.bottom + 6 }, [
      ...(empty ? [{ label: '第一个空位', key: `museum-hang:${art.id}:0`, onClick: () => act(s.museumHang(conv.id, { artId: art.id })) }] : []),
      ...view.hall.map((a, i) => ({
        label: `${title} No.${i + 1}${a.id ? `（《${a.title}》往后挪）` : '（空位）'}`,
        key: `museum-hang:${art.id}:${i + 1}`,
        onClick: () => act(s.museumHang(conv.id, { artId: art.id, slot: i + 1 })),
      })),
    ]);
  };
  const swapMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: r.bottom + 6 }, view.hall.flatMap((a, i) => i + 1 === art.slot ? [] : [{
      label: `和 No.${i + 1} ${a.id ? `《${a.title}》` : '（空位）'}调换`,
      key: `museum-swap:${art.slot}:${i + 1}`,
      onClick: () => act(s.museumSwap(conv.id, art.slot, i + 1)),
    }]));
  };
  return (
    <div className="flex flex-col gap-3 sm:flex-row" data-testid="museum-piece">
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl bg-black/[0.03] dark:bg-white/[0.04]">
        <Thumb v={v} art={art} full className="max-h-[55vh] min-h-48 w-full object-contain" />
      </div>
      <div className="flex w-full shrink-0 flex-col gap-2 sm:w-56">
        <div className="text-[1.05rem] font-semibold">《{art.title}》</div>
        <div className="space-y-0.5 text-[0.82rem] text-ink-soft dark:text-white/55">
          <div>挂的人：{who(v, art.byUserId)}</div>
          <div>方式：{art.method}{art.nsfw && ' · NSFW'}</div>
          {!own && <div>来自 #{art.convName}</div>}
          {art.slot > 0 && own && <div>第一展厅 No.{art.slot}</div>}
        </div>
        <div className="flex items-center gap-2">
          <LikeButton art={art} onLike={onLike} />
        </div>
        {own && tab !== 'second' && (
          <div className="flex flex-col gap-1.5 pt-1">
            {art.slot > 0 ? (
              <>
                <Button variant="soft" onClick={swapMenu}><ArrowLeftRight size={15} />调换位置…</Button>
                <Button variant="soft" onClick={() => act(s.museumRemove(conv.id, art.id))}><Undo2 size={15} />撤展（放回仓库）</Button>
              </>
            ) : (
              <Button variant="soft" onClick={(e) => slotMenu(e, '插到')}><Upload size={15} />挂回展厅…</Button>
            )}
          </div>
        )}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onBack}>返回</Button>
      </div>
    </div>
  );
}

function VoteRow({ v, vote, onVoted }: { v: SessionView; vote: MuseumVote; onVoted: () => Promise<void> }) {
  const s = session(v.id)!;
  const left = Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 60_000));
  const cast = async (agree: boolean) => {
    await s.museumVote(vote.id, agree);
    await onVoted();
  };
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-accent/[0.07] px-3 py-2" data-testid="museum-vote">
      {vote.mediaId && <Thumb v={v} art={vote} className="size-11 shrink-0 rounded-lg" />}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.88rem]">{who(v, vote.byUserId)}：{vote.text}</div>
        <div className="text-[0.75rem] text-ink-soft dark:text-white/50">同意 {vote.yes} · 反对 {vote.no} · {left > 0 ? `还剩 ${left} 分钟` : '马上出结果'}</div>
      </div>
      <Button size="sm" variant={vote.mine === 1 ? 'primary' : 'soft'} onClick={() => cast(true)}><Check size={14} />同意</Button>
      <Button size="sm" variant={vote.mine === -1 ? 'danger' : 'soft'} onClick={() => cast(false)}><X size={14} />反对</Button>
    </div>
  );
}

/** The 「挂到博物馆」 dialog for a picture in this channel's chat. */
const useHang = create<{ serverId: string; convId: string; eventId: string; mediaId: string; nsfw: boolean }>(() => ({ serverId: '', convId: '', eventId: '', mediaId: '', nsfw: false }));
export const askHang = (serverId: string, convId: string, eventId: string, mediaId: string, nsfw = false) =>
  useHang.setState({ serverId, convId, eventId, mediaId, nsfw });

export function HangDialog({ v, conv }: { v: SessionView; conv: Conversation }) {
  const h = useHang();
  const open = h.serverId === v.id && h.convId === conv.id && !!h.eventId;
  const [title, setTitle] = useState('');
  const [slot, setSlot] = useState(0);
  const [nsfw, setNsfw] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setSlot(0);
    setNsfw(h.nsfw);
  }, [open, h.eventId, h.nsfw]);
  const close = () => useHang.setState({ eventId: '' });
  const submit = async () => {
    told(await session(v.id)!.museumHang(conv.id, { eventId: h.eventId, title: title.trim(), slot, nsfw }));
    close();
  };
  return (
    <Dialog open={open} onClose={close} title="挂到博物馆" width={420}>
      {open && (
        <div className="space-y-3" data-testid="museum-hang">
          <Thumb v={v} art={{ mediaId: h.mediaId }} className="max-h-48 w-full rounded-xl object-contain" />
          <Field label="作品名" hint={`最多 ${MAX_TITLE} 个字，不填就叫「无题」`}>
            <Input value={title} maxLength={MAX_TITLE} placeholder="无题" onChange={(e) => setTitle(e.target.value)} aria-label="作品名" />
          </Field>
          <Field label="挂在哪">
            <select
              value={slot}
              onChange={(e) => setSlot(Number(e.target.value))}
              aria-label="挂在哪"
              className="h-10 w-full rounded-xl border border-black/10 bg-white/70 px-3 text-[0.9rem] dark:border-white/10 dark:bg-white/5"
            >
              <option value={0}>第一个空位（满了就挂不上）</option>
              {Array.from({ length: SLOTS }, (_, i) => <option key={i} value={i + 1}>插到 No.{i + 1}（后面的往后挪，最后一个进仓库）</option>)}
            </select>
          </Field>
          {conv.nsfw && <Toggle checked={nsfw} onChange={setNsfw} label="这是 NSFW 作品" />}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={close}>取消</Button>
            <Button variant="primary" onClick={submit}>挂上去</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
