// Our own music widgets (replacing the NetEase embed): 「一首歌」 and 「歌单」.
// Songs are sound files the owner uploaded; lib/player.ts plays them with
// one audio element for the whole app.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Disc3, Loader2, Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { clock, next, prev, seek, toggle, usePlayer, type Track } from '@/lib/player';
import { cx, spring } from '@/ui';
import { mediaPath, useMediaUrl } from '../media';

export interface SongConfig {
  title: string;
  artist: string;
  audioId: string;
  /** A NetEase song instead of an uploaded file. */
  neteaseId: string;
}

const trackOf = (key: string, serverId: string, s: SongConfig): Track | undefined =>
  s.neteaseId ? { key, serverId, neteaseId: s.neteaseId, title: s.title || '未命名', artist: s.artist }
    : s.audioId ? { key, serverId, mediaId: s.audioId, title: s.title || '未命名', artist: s.artist } : undefined;

/** Small mark on NetEase songs (they play from NetEase, not from this server). */
function Netease() {
  return <span className="shrink-0 rounded bg-rose-500/90 px-1 text-[0.62rem] leading-[1.2rem] font-medium text-white" title="从网易云播放">网易云</span>;
}

/** Three bars bouncing while a song plays (eased, never linear). */
function Bars({ on }: { on: boolean }) {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-current"
          animate={on ? { height: ['30%', '100%', '45%', '80%', '30%'] } : { height: '35%' }}
          transition={on ? { duration: 1.1 + i * 0.17, repeat: Infinity, ease: 'easeInOut' } : spring}
        />
      ))}
    </span>
  );
}

function Cover({ id, className, children }: { id: string; className?: string; children?: ReactNode }) {
  const url = useMediaUrl(id ? mediaPath(id, true) : undefined);
  return (
    <div className={cx('relative shrink-0 overflow-hidden bg-gradient-to-br from-accent-300 via-accent to-violet-500', className)}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" draggable={false} /> : <Music2 className="absolute inset-0 m-auto text-white/90" size={22} />}
      {children}
    </div>
  );
}

function PlayButton({ track, queue, disabled, big }: { track?: Track; queue?: Track[]; disabled?: boolean; big?: boolean }) {
  const cur = usePlayer((s) => (track && s.track?.key === track.key ? s : null));
  const playing = !!cur?.playing;
  const loading = !!cur?.loading;
  return (
    <motion.button
      type="button"
      disabled={disabled || !track}
      onClick={(e) => {
        e.stopPropagation();
        if (track) void toggle(track, queue);
      }}
      whileTap={{ scale: 0.88 }}
      transition={spring}
      aria-label={playing ? '暂停' : '播放'}
      className={cx(
        'flex shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-[0_6px_16px_-6px_var(--accent)] transition-opacity disabled:opacity-40',
        big ? 'h-11 w-11' : 'h-9 w-9',
      )}
    >
      {loading ? <Loader2 size={big ? 20 : 17} className="animate-spin" /> : playing ? <Pause size={big ? 20 : 17} fill="currentColor" /> : <Play size={big ? 20 : 17} fill="currentColor" className="translate-x-[1px]" />}
    </motion.button>
  );
}

/** Progress of the current song if it is one of `keys` (click to jump). `light` = white, over a picture. */
function Progress({ keys, editing, light }: { keys: string[]; editing: boolean; light?: boolean }) {
  const st = usePlayer((s) => (s.track && keys.includes(s.track.key) ? s : null));
  const frac = st && st.duration ? st.time / st.duration : 0;
  return (
    <div className={cx('flex items-center gap-2 text-[0.7rem] tabular-nums', light ? 'text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]' : 'text-ink-soft dark:text-white/50')}>
      <span className="w-8 text-right">{clock(st?.time ?? 0)}</span>
      <div
        role="slider"
        aria-label="播放进度"
        aria-valuenow={Math.round(frac * 100)}
        className={cx('relative h-1.5 flex-1 cursor-pointer rounded-full', light ? 'bg-white/30' : 'bg-black/10 dark:bg-white/10')}
        onClick={(e) => {
          if (editing || !st) return;
          const r = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        <motion.div className={cx('absolute inset-y-0 left-0 rounded-full', light ? 'bg-white' : 'bg-accent')} animate={{ width: `${frac * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
      </div>
      <span className="w-8">{clock(st?.duration ?? 0)}</span>
    </div>
  );
}

/** One line that glides back and forth when it is too long to fit (eased, with pauses at the ends). */
function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [over, setOver] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setOver(Math.max(0, (inner.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0)));
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={box} className={cx('min-w-0 overflow-hidden whitespace-nowrap', className)}>
      <motion.span
        ref={inner}
        className="inline-block"
        animate={over ? { x: [0, 0, -over - 4, -over - 4] } : { x: 0 }}
        transition={over ? { duration: 2 + over / 30, times: [0, 0.2, 0.8, 1], ease: 'easeInOut', repeat: Infinity, repeatType: 'reverse' } : spring}
      >
        {text}
      </motion.span>
    </div>
  );
}

/**
 * 「一首歌」: the cover fills the widget (cropped, never stretched; blurred
 * if the owner chose so), the title glides along the top, a plain white
 * play icon in the middle, the progress bar at the bottom.
 */
export function SongWidget({ serverId, keyBase, song, coverId, editing, blur }: {
  serverId: string; keyBase: string; song: SongConfig; coverId: string; editing: boolean; blur: boolean;
}) {
  const track = trackOf(`${keyBase}:0`, serverId, song);
  const cur = usePlayer((s) => (track && s.track?.key === track.key ? s : null));
  const url = useMediaUrl(coverId ? mediaPath(coverId) : undefined);
  if (!track && !editing) return <Placeholder text="还没选歌" />;
  const playing = !!cur?.playing;
  const title = `${song.title || '未命名'}${song.artist ? ` - ${song.artist}` : ''}`;
  return (
    <div className="relative h-full overflow-hidden text-white">
      {url
        ? <img src={url} alt="" draggable={false} className={cx('absolute inset-0 h-full w-full object-cover', blur && 'scale-110 blur-md')} />
        : <div className="absolute inset-0 bg-gradient-to-br from-accent-300 via-accent to-violet-500" />}
      <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/5 to-black/55" aria-hidden />
      <div className="relative flex h-full flex-col justify-between p-3">
        <div className="flex items-center gap-1.5 [text-shadow:0_1px_4px_rgba(0,0,0,0.6)]">
          {playing && <Bars on />}
          <Marquee text={title} className="flex-1 text-[0.95rem] font-semibold" />
          {song.neteaseId && <Netease />}
        </div>
        <motion.button
          type="button"
          disabled={editing || !track}
          onClick={(e) => {
            e.stopPropagation();
            if (track) void toggle(track);
          }}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.86 }}
          transition={spring}
          aria-label={playing ? '暂停' : '播放'}
          className="mx-auto flex items-center justify-center text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)] disabled:opacity-50"
        >
          {cur?.loading ? <Loader2 size={40} className="animate-spin" /> : playing ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" className="translate-x-[2px]" />}
        </motion.button>
        <div>
          {cur?.error && <div className="mb-1 truncate text-[0.72rem] text-rose-200 [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">{cur.error}</div>}
          {track ? <Progress keys={[track.key]} editing={editing} light /> : <div className="text-center text-[0.75rem] text-white/80">还没选歌</div>}
        </div>
      </div>
    </div>
  );
}

export function PlaylistWidget({ serverId, keyBase, title, coverId, songs, editing }: {
  serverId: string; keyBase: string; title: string; coverId: string; songs: SongConfig[]; editing: boolean;
}) {
  const queue: Track[] = songs.flatMap((s, i) => trackOf(`${keyBase}:${i}`, serverId, s) ?? []);
  const fromNetease = songs.some((s) => s.neteaseId);
  const keys = queue.map((t) => t.key);
  const cur = usePlayer((s) => (s.track && keys.includes(s.track.key) ? s : null));
  const current = cur?.track;
  if (!queue.length && !editing) return <Placeholder text="歌单还是空的" />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 p-3 pb-2">
        <Cover id={coverId} className="h-12 w-12 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><span className="truncate font-semibold">{title || '歌单'}</span>{fromNetease && <Netease />}</div>
          <div className="truncate text-[0.78rem] text-ink-soft dark:text-white/50">{current ? `正在放：${current.title}` : `${queue.length} 首`}</div>
        </div>
        <PlayButton track={current ?? queue[0]} queue={queue} disabled={editing} big />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
        {queue.map((t, i) => {
          const on = current?.key === t.key;
          return (
            <button
              key={t.key}
              type="button"
              disabled={editing}
              onClick={() => void toggle(t, queue)}
              className={cx('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors duration-200', on ? 'bg-accent-100/80 text-accent-700 dark:bg-white/10 dark:text-white' : 'hover:bg-black/[0.04] dark:hover:bg-white/5')}
            >
              <span className="flex w-5 shrink-0 justify-center text-[0.75rem] tabular-nums text-ink-soft dark:text-white/45">
                {on ? <Bars on={!!cur?.playing} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[0.88rem]">{t.title}</span>
              {t.artist && <span className="max-w-[40%] shrink-0 truncate text-[0.75rem] text-ink-soft dark:text-white/45">{t.artist}</span>}
            </button>
          );
        })}
      </div>
      <div className="space-y-1 px-3 pt-1 pb-2.5">
        {cur?.error && <div className="truncate text-[0.75rem] text-rose-500">{cur.error}</div>}
        <Progress keys={keys} editing={editing} />
        <div className="flex items-center justify-center gap-4 text-ink-soft dark:text-white/60">
          <button type="button" disabled={!current || editing} onClick={() => void prev()} aria-label="上一首" className="press rounded-full p-1.5 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"><SkipBack size={16} fill="currentColor" /></button>
          <Disc3 size={16} className={cx('transition-transform', cur?.playing && 'animate-[spin_3s_ease-in-out_infinite]')} />
          <button type="button" disabled={!current || editing} onClick={() => void next()} aria-label="下一首" className="press rounded-full p-1.5 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"><SkipForward size={16} fill="currentColor" /></button>
        </div>
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-[0.82rem] text-ink-soft dark:text-white/45">
      <Music2 size={22} />
      <span>{text}</span>
    </div>
  );
}

/** Songs from a widget config (`songs` for playlists). */
export function songsOf(v: unknown): SongConfig[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
    return { title: s('title'), artist: s('artist'), audioId: s('audio_id'), neteaseId: s('netease_id') };
  });
}
