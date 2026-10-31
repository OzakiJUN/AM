// The music player behind the 「一首歌」 / 「歌单」 widgets: one audio element
// for the whole app, so starting a song anywhere stops the one before.
// Songs are files uploaded to the server (no outside music service).
import { create } from 'zustand';
import { session } from './store';

export interface Track {
  /** Unique per widget and position: `${owner}:${widgetId}:${index}`. */
  key: string;
  serverId: string;
  /** An uploaded file on that server, or a NetEase song id (played from NetEase). */
  mediaId?: string;
  neteaseId?: string;
  title: string;
  artist: string;
}

interface PlayerState {
  track?: Track;
  /** The list the track came from (a playlist), for next / previous. */
  queue: Track[];
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  error?: string;
}

export const usePlayer = create<PlayerState>(() => ({ queue: [], playing: false, loading: false, time: 0, duration: 0 }));

let audio: HTMLAudioElement | null = null;

function el(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  const set = usePlayer.setState;
  audio.addEventListener('timeupdate', () => set({ time: audio!.currentTime }));
  audio.addEventListener('durationchange', () => set({ duration: Number.isFinite(audio!.duration) ? audio!.duration : 0 }));
  audio.addEventListener('playing', () => set({ playing: true, loading: false, error: undefined }));
  audio.addEventListener('pause', () => set({ playing: false }));
  audio.addEventListener('waiting', () => set({ loading: true }));
  audio.addEventListener('ended', () => void next(true));
  audio.addEventListener('error', () => set({
    playing: false, loading: false,
    error: usePlayer.getState().track?.neteaseId ? '网易云不让外链播放这首（会员或版权歌曲）' : '这首放不了（文件格式不支持或者已经被删了）',
  }));
  return audio;
}

/** Plays a track (from the start), remembering the list it belongs to. */
export async function play(track: Track, queue: Track[] = [track]) {
  const a = el();
  usePlayer.setState({ track, queue, loading: true, time: 0, duration: 0, error: undefined });
  try {
    const url = track.neteaseId ? neteaseUrl(track.neteaseId) : await session(track.serverId)?.t.mediaUrl(`/api/v1/media/${track.mediaId}`);
    if (!url || usePlayer.getState().track?.key !== track.key) return; // another song was picked meanwhile
    a.src = url;
    await a.play();
  } catch {
    usePlayer.setState({ loading: false, playing: false, error: '播放失败' });
  }
}

/** Play / pause the given track (starts it when another one is current). */
export function toggle(track: Track, queue?: Track[]) {
  const st = usePlayer.getState();
  if (st.track?.key !== track.key) return play(track, queue);
  const a = el();
  if (a.paused) void a.play().catch(() => {});
  else a.pause();
}

/** Jump to a fraction (0–1) of the current song. */
export function seek(frac: number) {
  const a = el();
  if (Number.isFinite(a.duration) && a.duration > 0) a.currentTime = Math.max(0, Math.min(1, frac)) * a.duration;
}

/** Next song in the list; `auto` = the last one ended (stops at the end of the list). */
export async function next(auto = false) {
  const { track, queue } = usePlayer.getState();
  const i = queue.findIndex((t) => t.key === track?.key);
  if (i < 0 || (auto && i === queue.length - 1)) {
    if (auto) usePlayer.setState({ playing: false, time: 0 });
    return;
  }
  await play(queue[(i + 1) % queue.length], queue);
}

export async function prev() {
  const { track, queue } = usePlayer.getState();
  const i = queue.findIndex((t) => t.key === track?.key);
  if (i < 0) return;
  // Like most players: more than 3 s in = back to the start of this song.
  if (el().currentTime > 3) {
    el().currentTime = 0;
    return;
  }
  await play(queue[(i - 1 + queue.length) % queue.length], queue);
}

/** Stops everything (leaving the page that played it is fine: it keeps playing until then). */
export function stopPlayer() {
  audio?.pause();
  usePlayer.setState({ track: undefined, queue: [], playing: false, time: 0, duration: 0 });
}

/** NetEase's own link for playing a song outside its app (free songs only). */
export const neteaseUrl = (id: string) => `https://music.163.com/song/media/outer/url?id=${id}.mp3`;

/** "3:07" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Title and artist from a file name: "周杰伦 - 晴天.mp3" -> 晴天 / 周杰伦. */
export function titleFromFile(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  return m ? { artist: m[1].trim().slice(0, 40), title: m[2].trim().slice(0, 60) } : { title: base.slice(0, 60), artist: '' };
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|ogg|opus|wav|webm)$/i;

/** A file the music widgets can take (same rule as the server's media.IsAudio, by name / type). */
export function isAudioFile(f: { name: string; type: string }): boolean {
  return f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);
}
