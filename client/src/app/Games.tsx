import { FishingWindow } from './Fishing';
// Board games in a channel or shared AI room (docs/design.md §13 小游戏):
// the 「开一局」 button in the header, the strip of this conversation's
// games above the messages, and the game window (board, seats, asking to
// join, 谁是卧底's words / descriptions / votes, 数字迷踪's cards, questions
// and guesses). The server checks the
// rules; lib/games.ts reads its state.
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Crown, Flag, Gamepad2, History, LogOut, Play, RotateCcw, Users, X } from 'lucide-react';
import { create } from 'zustand';
import { GAME_INFO, KINDS, TRAIL_MAX, TRAIL_QUESTIONS, coord, countStones, questionText, resultText, seatOf, stepText, type Game, type GameKind, type TrailQ } from '@/lib/games';
import { session } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation } from '@/lib/types';
import { chatTime } from '@/lib/format';
import { Button, Dialog, IconButton, Input, Segmented, Spinner, Toggle, cx, openMenu, spring, toast } from '@/ui';
import { UserAvatar } from './media';

/** The game window that is open (one at a time), and finished games I closed (out of the strip). */
export const useGameWindow = create<{ serverId: string; id: string; closed: string[] }>(() => ({ serverId: '', id: '', closed: [] }));
export const openGameWindow = (serverId: string, id: string) => useGameWindow.setState({ serverId, id });
const closeGame = (id: string) => useGameWindow.setState((s) => ({ id: s.id === id ? '' : s.id, closed: [...s.closed, id] }));

/** Opens a game of `kind` in a conversation and shows it. */
export async function startGame(serverId: string, convId: string, kind: GameKind) {
  const g = await session(serverId)!.openGame(convId, kind, false);
  openGameWindow(serverId, g.id);
  toast(`开了一局${GAME_INFO[kind].name}，${kind === 'fishing' ? '坐下就能钓鱼' : '等人加入'}`);
  return g;
}

/** Header button: 「开一局」 menu, and this conversation's game history. */
export function GameButton({ v, conv }: { v: SessionView; conv: Conversation }) {
  const [history, setHistory] = useState(false);
  return (
    <>
      <IconButton label="开一局游戏" onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu({ clientX: r.left, clientY: r.bottom + 6 }, [
          ...KINDS.map((k) => ({
            label: `${GAME_INFO[k].name}（${GAME_INFO[k].players}）`,
            icon: <Gamepad2 size={15} />,
            key: `game:${conv.id}:${k}`,
            onClick: () => startGame(v.id, conv.id, k),
          })),
          { label: '对局记录', icon: <History size={15} />, key: `history:${conv.id}`, onClick: () => setHistory(true) },
        ]);
      }}>
        <Gamepad2 size={19} />
      </IconButton>
      <Dialog open={history} onClose={() => setHistory(false)} title={`对局记录 · ${conv.name}`} width={560}>
        {history && <GameHistory v={v} conv={conv} onOpen={() => setHistory(false)} />}
      </Dialog>
    </>
  );
}

/** Finished games here, newest first; click one to see how it ended. */
function GameHistory({ v, conv, onOpen }: { v: SessionView; conv: Conversation; onOpen: () => void }) {
  const [list, setList] = useState<Game[] | null>(null);
  const [more, setMore] = useState(false);
  const load = async (before = 0) => {
    const page = await session(v.id)!.gameHistory(conv.id, before);
    setList((l) => [...(before ? l ?? [] : []), ...page]);
    setMore(page.length >= 30);
  };
  useEffect(() => {
    void load().catch(() => setList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id, conv.id]);
  if (!list) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!list.length) return <p className="py-8 text-center text-ink-soft dark:text-white/50">这里还没有下完的局。</p>;
  return (
    <div className="space-y-1.5" data-testid="game-history">
      <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
        {list.map((g) => (
          <button key={g.id} onClick={() => { session(v.id)!.showGame(g); openGameWindow(v.id, g.id); onOpen(); }}
            className="press flex w-full items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 text-left hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]">
            <Gamepad2 size={16} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{GAME_INFO[g.kind].name}</span>
                <span className="truncate text-[0.8rem] text-ink-soft dark:text-white/50">{g.players.map((p) => name(v, p.userId)).join('、')}</span>
              </div>
              <div className="truncate text-[0.82rem]">{resultText(g, (id) => name(v, id))}</div>
            </div>
            <span className="shrink-0 text-[0.75rem] text-ink-soft dark:text-white/45">{chatTime(g.updatedAt)}</span>
          </button>
        ))}
      </div>
      {more && <Button variant="soft" className="w-full" onClick={() => load(list.at(-1)!.updatedAt)}>更早的</Button>}
    </div>
  );
}

const name = (v: SessionView, id: string) => v.users[id]?.name ?? '…';

function statusLine(v: SessionView, g: Game): string {
  const info = GAME_INFO[g.kind];
  if (g.status === 'waiting') return `等人 ${g.players.length}/${info.max}${g.applicants.length ? ` · ${g.applicants.length} 人申请` : ''}`;
  if (g.status === 'ended') return resultText(g, (id) => name(v, id));
  if (g.kind === 'undercover' && g.state.phase === 'vote') return `第 ${g.state.round} 轮 · 投票中`;
  if (g.kind === 'fishing') return `${g.players.length}/12 人 · 随时可加入`;
  const who = g.waitingOn[0];
  return who ? `轮到 ${who === v.me?.id ? '你' : name(v, who)}` : '进行中';
}

/** The games of this conversation, above the messages (hidden when there are none). */
export function GameBar({ v, conv }: { v: SessionView; conv: Conversation }) {
  useEffect(() => {
    void session(v.id)?.listGames(conv.id).catch(() => {});
  }, [v.id, conv.id]);
  const closed = useGameWindow((s) => s.closed);
  const games = useMemo(
    () => Object.values(v.games).filter((g) => g.convId === conv.id && !closed.includes(g.id) && (g.status !== 'ended' || Date.now() - g.updatedAt < 30 * 60_000))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 4),
    [v.games, conv.id, closed],
  );
  const win = useGameWindow();
  const open = win.serverId === v.id && v.games[win.id]?.convId === conv.id ? v.games[win.id] : undefined;
  return (
    <>
      {games.length > 0 && (
        <div className="flex gap-2 overflow-x-auto border-b border-black/5 px-4 py-2 dark:border-white/5" aria-label="这里的游戏">
          {games.map((g) => {
            const mine = g.waitingOn.includes(v.me?.id ?? '');
            return (
              <motion.button
                key={g.id} layout transition={spring}
                onClick={() => openGameWindow(v.id, g.id)}
                className={cx('press flex shrink-0 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-[0.82rem]',
                  mine ? 'bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/10')}
              >
                <Gamepad2 size={15} className="shrink-0" />
                <span className="font-medium">{GAME_INFO[g.kind].name}</span>
                <span className={cx('max-w-[16rem] truncate', mine ? 'text-white/85' : 'text-ink-soft dark:text-white/55')}>{statusLine(v, g)}</span>
                {g.status === 'ended' && (
                  <span role="button" tabIndex={0} aria-label="关闭这局" title="关闭" className="-mr-1 rounded-md p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                    onClick={(e) => { e.stopPropagation(); closeGame(g.id); }}>
                    <X size={13} />
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      )}
      <Dialog open={!!open} onClose={() => useGameWindow.setState({ id: '' })} title={open ? GAME_INFO[open.kind].name : ''} width={open?.kind === 'undercover' || open?.kind === 'trail' ? 640 : 860}>
        {open && (open.kind === 'fishing' ? <FishingWindow v={v} g={open} /> : <GameWindow v={v} g={open} />)}
      </Dialog>
    </>
  );
}

function GameWindow({ v, g }: { v: SessionView; g: Game }) {
  const me = v.me?.id ?? '';
  const s = () => session(v.id)!;
  const seat = seatOf(g, me);
  const host = g.hostId === me;
  const info = GAME_INFO[g.kind];
  const asked = g.applicants.includes(me);
  return (
    <div className={cx('flex gap-5', !boardGame(g) ? 'flex-col' : 'flex-col md:flex-row')}>
      {boardGame(g) && g.status !== 'waiting' && <Board v={v} g={g} />}
      <div className="min-w-0 flex-1 space-y-3">
        <div className={cx('rounded-xl px-3 py-2 text-[0.9rem] font-medium', g.waitingOn.includes(me) ? 'bg-accent-100 text-accent-700 dark:bg-accent/20 dark:text-accent-100' : 'bg-black/[0.04] dark:bg-white/[0.05]')} data-testid="game-status">
          {g.status === 'waiting' ? `等人加入（${g.players.length}/${info.max}，至少 ${info.min} 人）` : statusLine(v, g)}
        </div>
        <Seats v={v} g={g} />
        {g.status === 'waiting' && host && g.applicants.length > 0 && (
          <div className="space-y-1.5" data-testid="game-applicants">
            <div className="text-[0.8rem] font-medium text-ink-soft dark:text-white/55">申请加入</div>
            {g.applicants.map((id) => (
              <div key={id} className="flex items-center gap-2 rounded-xl bg-amber-400/10 px-3 py-1.5">
                <UserAvatar user={v.users[id]} size={24} />
                <span className="min-w-0 flex-1 truncate">{name(v, id)}{v.users[id]?.type !== 'human' ? '（AI）' : ''}</span>
                <Button size="sm" variant="soft" key={`no:${id}`} onClick={() => s().decideGame(g.id, id, false)}>拒绝</Button>
                <Button size="sm" variant="primary" key={`yes:${id}`} onClick={() => s().decideGame(g.id, id, true)}>同意</Button>
              </div>
            ))}
          </div>
        )}
        {g.status === 'waiting' && host && (
          <div className="flex items-center gap-3 rounded-xl bg-black/[0.03] px-3 py-2 dark:bg-white/[0.04]">
            <span className="flex-1 text-[0.88rem]">有人申请就直接让进来</span>
            <Toggle label="自动同意" checked={g.autoApprove} onChange={(on) => s().setGameAuto(g.id, on)} />
          </div>
        )}
        {g.kind === 'undercover' && g.status !== 'waiting' && <Undercover v={v} g={g} />}
        {g.kind === 'trail' && g.status !== 'waiting' && <Trail v={v} g={g} />}
        <div className="flex flex-wrap gap-2">
          {g.status === 'waiting' && seat < 0 && (
            <Button variant="primary" disabled={asked || g.players.length >= info.max} onClick={() => s().gameStep(g.id, 'join').then((x) => toast(seatOf(x, me) >= 0 ? '坐下了' : '申请了，等开局的人同意'))}>
              <Users size={15} /> {asked ? '已申请，等同意' : g.players.length >= info.max ? '人满了' : '加入'}
            </Button>
          )}
          {g.status === 'waiting' && host && (
            <Button variant="primary" disabled={g.players.length < info.min} onClick={() => s().gameStep(g.id, 'start')}><Play size={15} /> 开始</Button>
          )}
          {g.status === 'waiting' && (seat >= 0 || asked) && (
            <Button variant="soft" onClick={() => s().gameStep(g.id, 'leave')}><LogOut size={15} /> {host ? '不玩了，关掉' : '退出'}</Button>
          )}
          {g.status === 'playing' && seat >= 0 && !g.players[seat].out && (
            <Button variant="soft" onClick={() => s().gameStep(g.id, 'leave')}><Flag size={15} /> {boardGame(g) ? '认输' : '退出这局'}</Button>
          )}
          {g.status === 'playing' && host && (
            <Button variant="soft" onClick={() => s().gameStep(g.id, 'end')}><X size={15} /> 结束这局</Button>
          )}
          {g.status === 'ended' && seat >= 0 && (
            <Button variant="primary" onClick={() => s().gameStep(g.id, 'rematch').then((x) => openGameWindow(v.id, x.id))}><RotateCcw size={15} /> 再来一局</Button>
          )}
          {g.status === 'ended' && (
            <Button variant="soft" onClick={() => closeGame(g.id)}><X size={15} /> 关闭</Button>
          )}
        </div>
        <p className="text-[0.78rem] leading-relaxed text-ink-soft dark:text-white/45">{info.rules}</p>
      </div>
    </div>
  );
}

/** 五子棋 / 黑白棋: two seats, black and white, a board. */
const boardGame = (g: Game) => g.kind === 'gomoku' || g.kind === 'reversi';

function Seats({ v, g }: { v: SessionView; g: Game }) {
  const board = boardGame(g);
  return (
    <div className="space-y-1">
      {g.players.map((p, i) => {
        const u = v.users[p.userId];
        const turn = g.waitingOn.includes(p.userId);
        return (
          <div key={p.userId} className={cx('flex items-center gap-2 rounded-xl px-2.5 py-1.5', turn && 'bg-accent-50 dark:bg-white/[0.06]', p.out && 'opacity-50')}>
            <span className="w-6 shrink-0 text-center text-[0.78rem] text-ink-soft tabular-nums dark:text-white/50">{i + 1}号</span>
            {board && <span className={cx('h-3.5 w-3.5 shrink-0 rounded-full', i === 0 ? 'bg-neutral-900 ring-1 ring-white/30' : 'bg-white ring-1 ring-black/20')} aria-hidden />}
            <UserAvatar user={u} size={24} presence />
            <span className="min-w-0 flex-1 truncate">{u?.name ?? '…'}{u && u.type !== 'human' ? '（AI）' : ''}</span>
            {p.userId === g.hostId && <Crown size={14} className="shrink-0 text-amber-500" aria-label="开局的人" />}
            {p.out && <span className="text-[0.75rem]">{p.spy ? '卧底，出局' : '出局'}</span>}
            {!p.out && g.status === 'ended' && g.kind === 'undercover' && p.spy && <span className="text-[0.75rem] text-rose-500">卧底</span>}
            {turn && <span className="shrink-0 text-[0.75rem] text-accent">{g.kind === 'undercover' && g.state.phase === 'vote' ? '在投票' : '思考中'}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The five star points of a 15×15 board (天元 and the four 星). */
const STARS = new Set(['3,3', '11,3', '7,7', '3,11', '11,11']);

/** 五子棋 / 黑白棋 board: click an empty (legal) point on my turn. */
function Board({ v, g }: { v: SessionView; g: Game }) {
  const st = g.state;
  const n = st.size ?? 0;
  const me = v.me?.id ?? '';
  const seat = seatOf(g, me);
  const myTurn = g.status === 'playing' && g.waitingOn.includes(me);
  const legal = new Set((myTurn && g.kind === 'reversi' ? st.legal ?? [] : []).map(([x, y]) => y * n + x));
  const [busy, setBusy] = useState(false);
  const go = async (x: number, y: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await session(v.id)!.actGame(g.id, { action: 'move', x, y });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const go15 = g.kind === 'gomoku';
  const cell = go15 ? 30 : 50;
  const [b, w] = countStones(st);
  return (
    <div className="shrink-0">
      <div
        className={cx('grid rounded-2xl p-2 shadow-[var(--shadow-card)]', go15 ? 'bg-[#e9c88f] dark:bg-[#8a6a3a]' : 'bg-emerald-700 dark:bg-emerald-900')}
        style={{ gridTemplateColumns: `repeat(${n}, ${cell}px)` }}
        role="grid" aria-label="棋盘"
      >
        {Array.from({ length: n * n }, (_, i) => {
          const x = i % n;
          const y = Math.floor(i / n);
          const c = st.board?.[i] ?? 0;
          const last = st.last && st.last[0] === x && st.last[1] === y;
          const can = myTurn && c === 0 && (go15 || legal.has(i));
          return (
            <button
              key={i}
              type="button"
              aria-label={coord(x, y)}
              disabled={!can || busy}
              onClick={() => void go(x, y)}
              className={cx('group relative flex items-center justify-center', !go15 && 'border border-black/25', can && 'cursor-pointer')}
              style={{ width: cell, height: cell }}
            >
              {go15 && (
                // 五子棋 is played on the points: each cell draws the two lines through its centre (cut at the edges).
                <>
                  <span aria-hidden className="absolute top-1/2 h-px -translate-y-1/2 bg-black/45" style={{ left: x === 0 ? '50%' : 0, right: x === n - 1 ? '50%' : 0 }} />
                  <span aria-hidden className="absolute left-1/2 w-px -translate-x-1/2 bg-black/45" style={{ top: y === 0 ? '50%' : 0, bottom: y === n - 1 ? '50%' : 0 }} />
                  {STARS.has(`${x},${y}`) && <span aria-hidden className="absolute h-1.5 w-1.5 rounded-full bg-black/70" />}
                </>
              )}
              {c !== 0 && (
                <motion.span
                  initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring}
                  className={cx('relative rounded-full shadow-[0_2px_4px_rgba(0,0,0,0.35)]', c === 1 ? 'bg-[radial-gradient(circle_at_35%_30%,#555,#111)]' : 'bg-[radial-gradient(circle_at_35%_30%,#fff,#ddd)]')}
                  style={{ width: cell * 0.8, height: cell * 0.8 }}
                />
              )}
              {last && <span className="absolute z-[1] h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />}
              {can && c === 0 && (
                <span className={cx('relative rounded-full opacity-0 transition-opacity duration-200 group-hover:opacity-60', seat === 0 ? 'bg-neutral-900' : 'bg-white', legal.has(i) && 'opacity-30')}
                  style={{ width: cell * (legal.has(i) ? 0.3 : 0.7), height: cell * (legal.has(i) ? 0.3 : 0.7) }} />
              )}
            </button>
          );
        })}
      </div>
      {g.kind === 'reversi' && <div className="mt-2 text-center text-[0.85rem] text-ink-soft dark:text-white/55">黑 {b} : 白 {w}</div>}
    </div>
  );
}

/** 谁是卧底: my word, what everyone said, saying mine, voting. */
function Undercover({ v, g }: { v: SessionView; g: Game }) {
  const me = v.me?.id ?? '';
  const seat = seatOf(g, me);
  const st = g.state;
  const [text, setText] = useState('');
  const s = () => session(v.id)!;
  const myTurn = g.status === 'playing' && g.waitingOn.includes(me);
  const rounds = [...new Set((st.said ?? []).map((x) => x.round))];
  const outs = (st.log ?? []).filter((l) => l.startsWith('out:') || l === 'tie');
  return (
    <div className="space-y-3">
      {seat >= 0 && g.players[seat].word && (
        <div className="rounded-xl bg-accent-50 px-3 py-2 dark:bg-white/[0.06]" data-testid="my-word">
          你的词：<span className="text-[1.1rem] font-bold">{g.players[seat].word}</span>
          {g.status === 'playing' && <span className="ml-2 text-[0.78rem] text-ink-soft dark:text-white/50">（你不知道自己是不是卧底）</span>}
        </div>
      )}
      {g.status === 'ended' && st.words?.length === 2 && (
        <div className="rounded-xl bg-black/[0.04] px-3 py-2 text-[0.88rem] dark:bg-white/[0.05]">平民的词：<b>{st.words[0]}</b>　卧底的词：<b>{st.words[1]}</b></div>
      )}
      <div className="max-h-56 space-y-2 overflow-y-auto">
        {rounds.map((r) => (
          <div key={r}>
            <div className="text-[0.75rem] font-medium text-ink-soft dark:text-white/50">第 {r} 轮</div>
            {(st.said ?? []).filter((x) => x.round === r).map((x) => (
              <div key={`${r}:${x.seat}`} className="text-[0.88rem]"><span className="text-ink-soft dark:text-white/55">{x.seat + 1}号 {name(v, g.players[x.seat]?.userId ?? '')}：</span>{x.text}</div>
            ))}
            {outs[r - 1] && (
              <div className="text-[0.8rem] text-rose-500">
                {outs[r - 1] === 'tie' ? '平票，没人出局' : `${Number(outs[r - 1].slice(4)) + 1}号 ${name(v, g.players[Number(outs[r - 1].slice(4))]?.userId ?? '')} 被投出局`}
              </div>
            )}
          </div>
        ))}
      </div>
      {myTurn && st.phase === 'describe' && (
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void s().actGame(g.id, { action: 'say', text }).then(() => setText('')).catch((err) => toast(err instanceof Error ? err.message : String(err), true));
        }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={60} placeholder="一句话描述你的词（别直接说出来）" aria-label="描述" />
          <Button variant="primary" type="submit" disabled={!text.trim()}>说</Button>
        </form>
      )}
      {myTurn && st.phase === 'vote' && (
        <div className="flex flex-wrap gap-2" data-testid="vote">
          <span className="w-full text-[0.85rem] font-medium">你觉得谁是卧底？</span>
          {g.players.map((p, i) => (i === seat || p.out ? null : (
            <Button key={p.userId} size="sm" variant="soft" onClick={() => s().actGame(g.id, { action: 'vote', target: i })}>
              投 {i + 1}号 {name(v, p.userId)}
            </Button>
          )))}
        </div>
      )}
    </div>
  );
}

/** 数字迷踪: everyone's cards (mine face up for me), what was asked and guessed, my turn. */
function Trail({ v, g }: { v: SessionView; g: Game }) {
  const me = v.me?.id ?? '';
  const seat = seatOf(g, me);
  const st = g.state;
  const hands = st.hands ?? [];
  const myTurn = g.status === 'playing' && g.waitingOn.includes(me);
  const others = g.players.flatMap((p, i) => (i !== seat && !p.out ? [i] : []));
  const [target, setTarget] = useState(-1);
  const [mode, setMode] = useState<'ask' | 'guess'>('ask');
  const [q, setQ] = useState<TrailQ>('gt');
  const [x, setX] = useState('10');
  const tgt = others.includes(target) ? target : others[0] ?? -1;
  const qInfo = TRAIL_QUESTIONS.find((t) => t.q === q)!;
  const needX = mode === 'guess' || qInfo.max > 0;
  const n = Number(x);
  const lo = mode === 'guess' ? 1 : qInfo.min;
  const hi = mode === 'guess' ? TRAIL_MAX : qInfo.max;
  const valid = tgt >= 0 && (!needX || (Number.isInteger(n) && n >= lo && n <= hi));
  const s = () => session(v.id)!;
  const act = () => s().actGame(g.id, mode === 'guess' ? { action: 'guess', target: tgt, x: n } : { action: 'ask', target: tgt, text: q, x: needX ? n : 0 });
  const steps = st.steps ?? [];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5" data-testid="trail-hands">
        {g.players.map((p, i) => {
          const h = hands[i];
          if (!h) return null;
          return (
            <div key={p.userId} className={cx('flex items-center gap-2', p.out && 'opacity-50')}>
              <span className="w-20 shrink-0 truncate text-[0.82rem] text-ink-soft dark:text-white/55">{i + 1}号 {i === seat ? '你' : name(v, p.userId)}</span>
              {h.nums.map((num, k) => {
                const open = h.shown[k];
                const mine = i === seat;
                return (
                  <motion.span key={k} layout transition={spring} title={h.hinted[k] && !open ? '猜错时公开过单双' : undefined}
                    className={cx('relative flex h-11 w-9 items-center justify-center rounded-lg text-[1rem] font-bold tabular-nums shadow-sm',
                      open ? 'bg-white text-ink ring-1 ring-black/10 dark:bg-white/90' : mine ? 'bg-accent-100 text-accent-700 dark:bg-accent/25 dark:text-white' : 'bg-gradient-to-br from-slate-600 to-slate-800 text-white/80')}
                    data-testid={open ? 'card-open' : 'card'}>
                    {open || mine ? num : '?'}
                    {h.hinted[k] && !open && (
                      <span className="absolute -right-1.5 -bottom-1.5 rounded-full bg-amber-400 px-1 text-[0.6rem] leading-4 text-black">
                        {mine ? (num % 2 ? '单' : '双') : stepHint(steps, i, k)}
                      </span>
                    )}
                    {open && <span className="absolute inset-x-1 bottom-0.5 h-0.5 rounded bg-rose-400/70" aria-hidden />}
                  </motion.span>
                );
              })}
              {i === seat && g.status === 'playing' && <span className="text-[0.72rem] text-ink-soft dark:text-white/45">只有你看得到</span>}
            </div>
          );
        })}
      </div>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl bg-black/[0.03] p-2.5 text-[0.84rem] dark:bg-white/[0.04]" data-testid="trail-steps">
        {steps.length ? steps.map((x2, i) => (
          <div key={i} className={cx(x2.kind === 'guess' && x2.yes && 'font-medium text-emerald-700 dark:text-emerald-300')}>{stepText(g, x2, (id) => name(v, id))}</div>
        )) : <div className="text-ink-soft dark:text-white/45">还没人行动。</div>}
      </div>
      {myTurn && (
        <form className="space-y-2 rounded-xl bg-accent-50 p-3 dark:bg-white/[0.06]" data-testid="trail-act" onSubmit={(e) => {
          e.preventDefault();
          if (valid) void act().catch((err) => toast(err instanceof Error ? err.message : String(err), true));
        }}>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented id="trail-mode" value={mode} onChange={setMode} options={[{ value: 'ask', label: '问' }, { value: 'guess', label: '猜' }]} />
            <select value={tgt} onChange={(e) => setTarget(Number(e.target.value))} aria-label="对谁"
              className="h-9 rounded-xl border border-black/10 bg-white/90 px-2 text-[0.88rem] dark:border-white/10 dark:bg-white/5">
              {others.map((i) => <option key={i} value={i}>{i + 1}号 {name(v, g.players[i].userId)}</option>)}
            </select>
            {mode === 'ask' && (
              <select value={q} onChange={(e) => setQ(e.target.value as TrailQ)} aria-label="问什么"
                className="h-9 rounded-xl border border-black/10 bg-white/90 px-2 text-[0.88rem] dark:border-white/10 dark:bg-white/5">
                {TRAIL_QUESTIONS.map((t) => <option key={t.q} value={t.q}>{t.text}</option>)}
              </select>
            )}
            {needX && (
              <div className="w-20 shrink-0">
                <Input value={x} onChange={(e) => setX(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" aria-label={mode === 'guess' ? '猜的数' : 'X'}
                  placeholder={`${lo}–${hi}`} className="h-9" />
              </div>
            )}
            <Button variant="primary" type="submit" disabled={!valid}>{mode === 'guess' ? '猜' : '问'}</Button>
          </div>
          <div className="text-[0.78rem] text-ink-soft dark:text-white/50">
            {tgt < 0 ? '' : mode === 'guess'
              ? `猜 ${tgt + 1}号 有 ${valid ? n : '?'}：猜错了要公开你一张牌的单双。`
              : `问 ${tgt + 1}号：${questionText(q, valid ? n : 0)}？${needX ? `（X 在 ${lo}–${hi}）` : ''}`}
          </div>
        </form>
      )}
    </div>
  );
}

/** Parity of someone else's card k, from the wrong guess that gave it away. */
function stepHint(steps: Game['state']['steps'], seat: number, k: number): string {
  const s = (steps ?? []).find((x) => x.kind === 'guess' && !x.yes && x.seat === seat && x.hint === k);
  return s ? (s.odd ? '单' : '双') : '?';
}
