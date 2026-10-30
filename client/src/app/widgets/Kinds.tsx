// What each built-in widget shows on a profile board. Settings live in the
// widget's JSON config (see lib/widgetKinds.ts); editing is in Editor.tsx.
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ExternalLink, ImageOff, Music2, Puzzle } from 'lucide-react';
import { presenceText } from '@/lib/presence';
import { openUrl } from '@/lib/platform';
import type { ProfileData, ProfileTarget, SessionView } from '@/lib/session';
import type { User } from '@/lib/types';
import { daysUntil, STAT_ITEMS, type ProfileKind } from '@/lib/widgetKinds';
import type { WidgetModel } from '@/lib/widgets';
import { Dialog, ask, cx } from '@/ui';
import { UserAvatar, mediaPath, useMediaUrl } from '../media';
import { Guestbook } from './Guestbook';

export interface WidgetCtx {
  v: SessionView;
  target: ProfileTarget;
  profileKind: ProfileKind;
  data: ProfileData;
  /** The profile's user (user profiles). */
  owner?: User;
  /** Board is being edited: widgets don't react to clicks. */
  editing: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function WidgetView({ w, ctx }: { w: WidgetModel; ctx: WidgetCtx }) {
  if (w.source === 'workshop') return <WorkshopWidget w={w} />;
  const c = w.config;
  switch (w.kind) {
    case 'text': return <TextWidget title={str(c.title)} text={str(c.text)} />;
    case 'image': return <ImageWidget id={str(c.media_id)} caption={str(c.caption)} fit={str(c.fit) === 'contain' ? 'contain' : 'cover'} editing={ctx.editing} />;
    case 'gallery': return <GalleryWidget ids={strs(c.media_ids)} interval={num(c.interval, 5)} caption={str(c.caption)} editing={ctx.editing} />;
    case 'links': return <LinksWidget items={Array.isArray(c.items) ? (c.items as { title?: string; url?: string }[]) : []} editing={ctx.editing} />;
    case 'countdown': return <CountdownWidget title={str(c.title)} date={num(c.date)} />;
    case 'stats': return <StatsWidget ctx={ctx} items={strs(c.items)} wide={w.w >= 3} />;
    case 'guestbook': return <Guestbook ctx={ctx} widgetId={w.id} title={str(c.title) || '留言板'} />;
    case 'music': return <MusicWidget id={str(c.playlist_id)} title={str(c.title)} editing={ctx.editing} tall={w.h >= 3} />;
    case 'status': return <StatusWidget ctx={ctx} />;
    case 'online': return <OnlineWidget ctx={ctx} />;
    default: return <Placeholder icon={<Puzzle size={22} />} text={`这个客户端还不认识「${w.kind}」小组件，更新一下试试`} />;
  }
}

function Placeholder({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-[0.82rem] text-ink-soft dark:text-white/45">
      {icon}
      <span>{text}</span>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 truncate text-[0.95rem] font-semibold">{children}</div>;
}

function TextWidget({ title, text }: { title: string; text: string }) {
  if (!title && !text) return <Placeholder icon={<span className="text-2xl">📝</span>} text="还没写内容" />;
  return (
    <div className="flex h-full flex-col p-4">
      {title && <Title>{title}</Title>}
      <div className="selectable min-h-0 flex-1 overflow-y-auto text-[0.9rem] leading-relaxed whitespace-pre-wrap text-ink-soft dark:text-white/70">{text}</div>
    </div>
  );
}

/** Full-size picture viewer. */
function Lightbox({ id, onClose }: { id: string | null; onClose: () => void }) {
  const url = useMediaUrl(id ? mediaPath(id) : undefined);
  return (
    <Dialog open={!!id} onClose={onClose} width={900}>
      {url && <img src={url} alt="" className="max-h-[75vh] w-full rounded-2xl object-contain" />}
    </Dialog>
  );
}

function Picture({ id, fit, onClick }: { id: string; fit: 'cover' | 'contain'; onClick?: () => void }) {
  const url = useMediaUrl(mediaPath(id));
  return (
    <button onClick={onClick} disabled={!onClick} className="absolute inset-0 h-full w-full" aria-label="看大图">
      {url ? <img src={url} alt="" draggable={false} className={cx('h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover')} /> : null}
    </button>
  );
}

function ImageWidget({ id, caption, fit, editing }: { id: string; caption: string; fit: 'cover' | 'contain'; editing: boolean }) {
  const [big, setBig] = useState<string | null>(null);
  if (!id) return <Placeholder icon={<ImageOff size={22} />} text="还没选图片" />;
  return (
    <>
      <Picture id={id} fit={fit} onClick={editing ? undefined : () => setBig(id)} />
      {caption && <Caption text={caption} />}
      <Lightbox id={big} onClose={() => setBig(null)} />
    </>
  );
}

function Caption({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent px-3 pt-6 pb-2 text-[0.85rem] text-white">
      <span className="line-clamp-2">{text}</span>
    </div>
  );
}

function GalleryWidget({ ids, interval, caption, editing }: { ids: string[]; interval: number; caption: string; editing: boolean }) {
  const [i, setI] = useState(0);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    if (ids.length < 2 || big) return;
    const t = setInterval(() => setI((n) => (n + 1) % ids.length), Math.max(2, interval) * 1000);
    return () => clearInterval(t);
  }, [ids.length, interval, big]);
  if (!ids.length) return <Placeholder icon={<ImageOff size={22} />} text="还没选照片" />;
  const cur = ids[i % ids.length];
  return (
    <>
      <AnimatePresence initial={false}>
        <motion.div
          key={cur + i}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        >
          <Picture id={cur} fit="cover" onClick={editing ? undefined : () => setBig(cur)} />
        </motion.div>
      </AnimatePresence>
      {caption && <Caption text={caption} />}
      {ids.length > 1 && (
        <div className="absolute top-2 right-2 flex gap-1 rounded-full bg-black/30 px-1.5 py-1 backdrop-blur">
          {ids.map((id, n) => (
            <button
              key={id + n}
              onClick={() => setI(n)}
              aria-label={`第 ${n + 1} 张`}
              className={cx('h-1.5 rounded-full transition-all duration-300', n === i % ids.length ? 'w-4 bg-white' : 'w-1.5 bg-white/55')}
            />
          ))}
        </div>
      )}
      <Lightbox id={big} onClose={() => setBig(null)} />
    </>
  );
}

function LinksWidget({ items, editing }: { items: { title?: string; url?: string }[]; editing: boolean }) {
  const list = items.filter((x) => x.url);
  if (!list.length) return <Placeholder icon={<span className="text-2xl">🔗</span>} text="还没加链接" />;
  const open = (url: string) =>
    ask({ title: '打开外部链接？', text: url, ok: '打开' }).then((ok) => {
      if (ok !== null) openUrl(url);
    });
  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-2.5">
      {list.map((l, n) => (
        <button
          key={n}
          disabled={editing}
          onClick={() => open(l.url!)}
          className="lift flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-black/[0.04] dark:hover:bg-white/5"
        >
          <ExternalLink size={15} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[0.9rem] font-medium">{l.title || l.url}</span>
            <span className="block truncate text-[0.72rem] text-ink-soft dark:text-white/40">{hostOf(l.url!)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function CountdownWidget({ title, date }: { title: string; date: number }) {
  if (!date) return <Placeholder icon={<span className="text-2xl">⏳</span>} text="还没选日期" />;
  const d = daysUntil(date);
  const when = new Date(date);
  return (
    <div className="flex h-full flex-col items-center justify-center p-3 text-center">
      <div className="truncate text-[0.85rem] text-ink-soft dark:text-white/55">{title || '倒计时'}</div>
      <div className="my-0.5 text-[2rem] leading-tight font-bold text-accent tabular-nums">{d === 0 ? '今天' : Math.abs(d)}</div>
      <div className="text-[0.78rem] text-ink-soft dark:text-white/45">
        {d > 0 ? '天后' : d < 0 ? '天前' : ''} · {when.getFullYear()}-{String(when.getMonth() + 1).padStart(2, '0')}-{String(when.getDate()).padStart(2, '0')}
      </div>
    </div>
  );
}

function StatsWidget({ ctx, items, wide }: { ctx: WidgetCtx; items: string[]; wide: boolean }) {
  const st = ctx.data.stats;
  const defs = STAT_ITEMS[ctx.profileKind];
  const shown = defs.filter((d) => (items.length ? items.includes(d.key) : true));
  const daysSince = (t: number) => (t ? Math.max(1, -daysUntil(t) + 1) : 0);
  const value = (key: string): [string, string] => {
    switch (key) {
      case 'messages': return [st.messages.toLocaleString(), '条'];
      case 'streak': return [String(st.streakDays), '天'];
      case 'joined': return [String(daysSince(st.joinedAt)), '天'];
      case 'members': return [String(st.members), '人'];
      case 'channels': return [String(st.channels), '个'];
      case 'age': return [String(daysSince(st.createdAt)), '天'];
      default: return ['—', ''];
    }
  };
  return (
    <div className={cx('grid h-full gap-2 p-3', wide ? 'auto-cols-fr grid-flow-col' : 'grid-cols-2')}>
      {shown.map((d) => {
        const [n, unit] = value(d.key);
        return (
          <div key={d.key} className="flex min-w-0 flex-col items-center justify-center rounded-2xl bg-accent-50/70 px-2 py-1.5 text-center dark:bg-white/[0.04]">
            <div className="truncate text-[1.35rem] leading-tight font-bold text-accent tabular-nums">
              {n}<span className="ml-0.5 text-[0.75rem] font-medium text-ink-soft dark:text-white/50">{unit}</span>
            </div>
            <div className="truncate text-[0.75rem] text-ink-soft dark:text-white/50">{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * NetEase Cloud Music's official embeddable player. It is loaded only after
 * a click, so nobody's client talks to music.163.com just by opening a profile.
 */
function MusicWidget({ id, title, editing, tall }: { id: string; title: string; editing: boolean; tall: boolean }) {
  const [on, setOn] = useState(false);
  if (!id) return <Placeholder icon={<Music2 size={22} />} text="还没填歌单链接" />;
  if (!on || editing) {
    return (
      <button
        disabled={editing}
        onClick={() => setOn(true)}
        className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-rose-500/90 to-red-600/90 p-3 text-center text-white"
      >
        <Music2 size={28} />
        <span className="font-semibold">{title || '网易云歌单'}</span>
        <span className="text-[0.75rem] opacity-85">点一下加载播放器（会连接 music.163.com）</span>
      </button>
    );
  }
  return (
    <iframe
      title={title || '网易云歌单'}
      src={`https://music.163.com/outchain/player?type=0&id=${id}&auto=0&height=${tall ? 430 : 90}`}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-same-origin allow-popups"
      referrerPolicy="no-referrer"
    />
  );
}

function StatusWidget({ ctx }: { ctx: WidgetCtx }) {
  const u = ctx.owner;
  const p = u ? ctx.v.presence[u.id] : undefined;
  return (
    <div className="flex h-full items-center gap-3 p-3">
      <UserAvatar user={u} size={42} presence />
      <div className="min-w-0">
        <div className="truncate font-semibold">{u?.name}</div>
        <div className="truncate text-[0.85rem] text-ink-soft dark:text-white/55">{presenceText(p)}</div>
      </div>
    </div>
  );
}

function OnlineWidget({ ctx }: { ctx: WidgetCtx }) {
  const ids = Object.keys(ctx.v.presence).filter((id) => !ctx.v.presence[id]?.invisible || id === ctx.v.me?.id);
  return (
    <div className="flex h-full flex-col p-3">
      <Title>在线 · {ids.length}</Title>
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-2 overflow-y-auto">
        {ids.map((id) => {
          const u = ctx.v.users[id] ?? (id === ctx.v.me?.id ? ctx.v.me : undefined);
          return (
            <div key={id} className="flex w-14 flex-col items-center gap-1" title={u?.name}>
              <UserAvatar user={u} size={36} presence />
              <span className="w-full truncate text-center text-[0.7rem] text-ink-soft dark:text-white/50">{u?.name ?? '…'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Workshop widgets (stage 5): until the sandboxed runtime exists, show the
 * owner's snapshot picture, or a placeholder.
 */
function WorkshopWidget({ w }: { w: WidgetModel }) {
  if (w.snapshotMediaId) {
    return (
      <>
        <Picture id={w.snapshotMediaId} fit="cover" />
        <Caption text={`工坊组件 · ${w.workshop?.id ?? w.kind}（只显示截图）`} />
      </>
    );
  }
  return <Placeholder icon={<Puzzle size={22} />} text={`工坊组件「${w.workshop?.id ?? w.kind}」，这个版本还不能运行`} />;
}
