// Our own music widgets (replacing the NetEase embed): 「一首歌」 and 「歌单」.
// Songs are sound files the owner uploaded; lib/player.ts plays them with
// one audio element for the whole app.
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import { Disc3, Loader2, Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { clock, next, prev, seek, toggle, usePlayer, type Track } from '@/lib/player';
import { cx, spring } from '@/ui';
import { mediaPath, useMediaUrl } from '../media';

export interface SongConfig {
  title: string;
  artist: string;
  audioId: string;
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

/** Progress of the current song if it is one of `keys` (click to jump). */
function Progress({ keys, editing }: { keys: string[]; editing: boolean }) {
  const st = usePlayer((s) => (s.track && keys.includes(s.track.key) ? s : null));
  const frac = st && st.duration ? st.time / st.duration : 0;
  return (
    <div className="flex items-center gap-2 text-[0.7rem] tabular-nums text-ink-soft dark:text-white/50">
      <span className="w-8 text-right">{clock(st?.time ?? 0)}</span>
      <div
        role="slider"
        aria-label="播放进度"
        aria-valuenow={Math.round(frac * 100)}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-black/10 dark:bg-white/10"
        onClick={(e) => {
          if (editing || !st) return;
          const r = e.currentTarget.getBoundingClientRect();
          seek((e.clientX - r.left) / r.width);
        }}
      >
        <motion.div className="absolute inset-y-0 left-0 rounded-full bg-accent" animate={{ width: `${frac * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 24 }} />
      </div>
      <span className="w-8">{clock(st?.duration ?? 0)}</span>
    </div>
  );
}

export function SongWidget({ serverId, keyBase, song, coverId, editing, tall }: {
  serverId: string; keyBase: string; song: SongConfig; coverId: string; editing: boolean; tall: boolean;
}) {
  const track: Track | undefined = song.audioId ? { key: `${keyBase}:0`, serverId, mediaId: song.audioId, title: song.title || '未命名', artist: song.artist } : undefined;
  const error = usePlayer((s) => (track && s.track?.key === track.key ? s.error : undefined));
  const playing = usePlayer((s) => !!track && s.track?.key === track.key && s.playing);
  if (!track && !editing) return <Placeholder text="还没选歌" />;
  return (
    <div className={cx('flex h-full gap-3 p-3', tall ? 'flex-col' : 'items-center')}>
      <Cover id={coverId} className={tall ? 'aspect-square w-full flex-1 rounded-2xl' : 'h-full max-h-16 w-16 rounded-xl'}>
        {playing && <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/40 px-1 py-0.5 text-white"><Bars on /></span>}
      </Cover>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{song.title || '未命名'}</div>
            <div className="truncate text-[0.8rem] text-ink-soft dark:text-white/50">{error ?? (song.artist || ' ')}</div>
          </div>
          <PlayButton track={track} disabled={editing} />
        </div>
        {track && <Progress keys={[track.key]} editing={editing} />}
      </div>
    </div>
  );
}

export function PlaylistWidget({ serverId, keyBase, title, coverId, songs, editing }: {
  serverId: string; keyBase: string; title: string; coverId: string; songs: SongConfig[]; editing: boolean;
}) {
  const queue: Track[] = songs.flatMap((s, i) => (s.audioId ? [{ key: `${keyBase}:${i}`, serverId, mediaId: s.audioId, title: s.title || '未命名', artist: s.artist }] : []));
  const keys = queue.map((t) => t.key);
  const cur = usePlayer((s) => (s.track && keys.includes(s.track.key) ? s : null));
  const current = cur?.track;
  if (!queue.length && !editing) return <Placeholder text="歌单还是空的" />;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 p-3 pb-2">
        <Cover id={coverId} className="h-12 w-12 rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{title || '歌单'}</div>
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
    return { title: s('title'), artist: s('artist'), audioId: s('audio_id') };
  });
}
