// Board games in channels and shared AI rooms (docs/design.md §13 小游戏):
// the server holds the game and checks the rules (server/internal/game);
// this is the client side's pure part (tested): reading a game, board
// coordinates, the text an AI reads, and a fallback move for AIs whose
// model did not move.

export type GameKind = 'gomoku' | 'reversi' | 'undercover';

export interface GamePlayer {
  userId: string;
  out: boolean;
  spy: boolean;
  word: string;
}

export interface GameState {
  size?: number;
  board?: number[];
  turn: number;
  moves?: number;
  last?: number[];
  winner?: number;
  result?: string;
  phase?: 'describe' | 'vote';
  round?: number;
  said?: { seat: number; round: number; text: string }[];
  votes?: number[];
  words?: string[];
  log?: string[];
  legal?: [number, number][];
}

export interface Game {
  id: string;
  convId: string;
  kind: GameKind;
  hostId: string;
  status: 'waiting' | 'playing' | 'ended';
  players: GamePlayer[];
  applicants: string[];
  autoApprove: boolean;
  waitingOn: string[];
  state: GameState;
  createdAt: number;
  updatedAt: number;
}

export const GAME_INFO: Record<GameKind, { name: string; players: string; min: number; max: number; rules: string }> = {
  gomoku: {
    name: '五子棋', players: '2 人', min: 2, max: 2,
    rules: '15×15 棋盘，黑先白后轮流落子，横竖斜先连成五个（或更多）的赢。开局的人执黑。',
  },
  reversi: {
    name: '黑白棋', players: '2 人', min: 2, max: 2,
    rules: '8×8 棋盘，落子必须夹住对方的子，夹住的全部翻成自己的颜色；一方无处可下就跳过，都下不了时子多的赢。开局的人执黑。',
  },
  undercover: {
    name: '谁是卧底', players: '4–8 人', min: 4, max: 8,
    rules: '每人拿到一个词，卧底的词和大家的相近但不一样（7 人以上 2 个卧底）。按座位轮流用一句话描述自己的词（不能直接说出来），说完大家投票，票最多的出局。卧底全部出局平民赢；卧底人数追平平民，或撑过 8 轮，卧底赢。',
  },
};

export const KINDS = Object.keys(GAME_INFO) as GameKind[];

/** Column letters A–O (plain, no skipped letters: easier for models). */
const COLS = 'ABCDEFGHIJKLMNO';

/** (x, y) -> "H8": letter = column from the left, number = row from the top (1-based). */
export function coord(x: number, y: number): string {
  return `${COLS[x] ?? '?'}${y + 1}`;
}

/** "H8", "h8", "8H", "H 8", "(7,7)" -> [x, y] inside the board, or null. */
export function parseCoord(text: string, size: number): [number, number] | null {
  const t = text.trim().toUpperCase();
  let m = /^([A-Z])\s*(\d{1,2})$/.exec(t) ?? null;
  let x: number;
  let y: number;
  if (m) {
    x = COLS.indexOf(m[1]);
    y = Number(m[2]) - 1;
  } else if ((m = /^(\d{1,2})\s*([A-Z])$/.exec(t))) {
    x = COLS.indexOf(m[2]);
    y = Number(m[1]) - 1;
  } else if ((m = /^\(?\s*(\d{1,2})\s*[,，]\s*(\d{1,2})\s*\)?$/.exec(t))) {
    x = Number(m[1]);
    y = Number(m[2]);
  } else return null;
  return x >= 0 && y >= 0 && x < size && y < size ? [x, y] : null;
}

/** The board as text: "●" black, "○" white, "·" empty (the last move is said separately). */
export function boardText(st: GameState): string {
  const n = st.size ?? 0;
  const b = st.board ?? [];
  const lines = ['    ' + [...COLS.slice(0, n)].join(' ')];
  for (let y = 0; y < n; y++) {
    let row = String(y + 1).padStart(2, ' ') + '  ';
    for (let x = 0; x < n; x++) {
      const c = b[y * n + x];
      row += (c === 1 ? '●' : c === 2 ? '○' : '·') + ' ';
    }
    lines.push(row.trimEnd());
  }
  return lines.join('\n');
}

/** Seat of a user (-1 = not playing). */
export const seatOf = (g: Game, user: string) => g.players.findIndex((p) => p.userId === user);

/** Black / white stones on the board. */
export function countStones(st: GameState): [number, number] {
  let b = 0;
  let w = 0;
  for (const c of st.board ?? []) {
    if (c === 1) b++;
    else if (c === 2) w++;
  }
  return [b, w];
}

/** One line about the outcome, e.g. "小鱼（黑）赢了" / "平民赢了，卧底是：…". */
export function resultText(g: Game, nameOf: (id: string) => string): string {
  const st = g.state;
  if (g.status !== 'ended') return '';
  if (st.result === 'closed') return '这局被关掉了';
  const w = st.winner ?? 0;
  if (g.kind === 'undercover') {
    if (!w) return '这局结束了';
    const spies = g.players.filter((p) => p.spy).map((p) => nameOf(p.userId)).join('、');
    const words = st.words?.length === 2 ? `（平民：${st.words[0]}，卧底：${st.words[1]}）` : '';
    return `${w === 1 ? '平民赢了' : st.result === 'rounds' ? '卧底撑过了 8 轮，卧底赢了' : '卧底赢了'}，卧底是 ${spies}${words}`;
  }
  if (w === -1) return '平局';
  if (w > 0) {
    const p = g.players[w - 1];
    const tail = g.kind === 'reversi' ? `（${countStones(st).join(' : ')}）` : '';
    return `${p ? nameOf(p.userId) : '?'}（${w === 1 ? '黑' : '白'}）赢了${st.result === 'resign' ? '，对方认输' : ''}${tail}`;
  }
  return '这局结束了';
}

/**
 * What an AI reads about a game it plays (its own view): the rules in short,
 * the board or the descriptions so far, and what it should do now.
 */
export function gameText(g: Game, me: string, nameOf: (id: string) => string): string {
  const info = GAME_INFO[g.kind];
  const seat = seatOf(g, me);
  const st = g.state;
  const who = g.players.map((p, i) => `${i + 1}号 ${nameOf(p.userId)}${p.userId === me ? '（你）' : ''}${p.out ? '（已出局）' : ''}`).join('，');
  const lines = [`【${info.name}】游戏编号 ${g.id}。规则：${info.rules}`, `玩家：${who}`];
  if (g.status === 'waiting') {
    lines.push(`还没开始（${g.players.length} / ${info.max} 人）。`);
    return lines.join('\n');
  }
  if (g.status === 'ended') {
    lines.push('已经结束：' + resultText(g, nameOf));
    return lines.join('\n');
  }
  const mine = g.waitingOn.includes(me);
  if (g.kind === 'undercover') {
    if (seat >= 0) lines.push(`你的词是「${g.players[seat].word}」。你不知道自己是平民还是卧底，要从别人的描述里判断。`);
    lines.push(`第 ${st.round} 轮，${st.phase === 'vote' ? '投票阶段' : '描述阶段'}。`);
    const said = (st.said ?? []).map((x) => `第${x.round}轮 ${x.seat + 1}号 ${nameOf(g.players[x.seat]?.userId ?? '')}：${x.text}`);
    if (said.length) lines.push('大家的描述：\n' + said.join('\n'));
    const outs = g.players.flatMap((p, i) => (p.out ? [`${i + 1}号${p.spy ? '（是卧底）' : '（是平民）'}`] : []));
    if (outs.length) lines.push('已出局：' + outs.join('，'));
    if (mine) {
      lines.push(st.phase === 'vote'
        ? '轮到你投票了：用 game_vote 投给你觉得是卧底的人（填座位号，不能投自己）。'
        : '轮到你描述了：用 game_say 说一句话描述你的词（不能说出词本身，别太直白，也别太偏）。');
    }
    return lines.join('\n');
  }
  const color = seat === 0 ? '黑（●）' : seat === 1 ? '白（○）' : '';
  if (color) lines.push(`你执${color}。`);
  if (st.last) lines.push(`上一步：${coord(st.last[0], st.last[1])}。`);
  if (g.kind === 'reversi') {
    const [b, w] = countStones(st);
    lines.push(`现在 黑 ${b} : 白 ${w}。`);
  }
  lines.push('棋盘（字母是列，数字是行）：\n' + boardText(st));
  if (mine) {
    const legal = g.kind === 'reversi' && st.legal?.length ? `能下的位置：${st.legal.map(([x, y]) => coord(x, y)).join(' ')}。` : '';
    lines.push(`轮到你了：用 game_move 落子，位置写成「H8」这样（列字母 + 行号）。${legal}`);
  }
  return lines.join('\n');
}

const DIRS: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];

/**
 * A reasonable gomoku move for `me` (1 black, 2 white) when the model
 * didn't make one: win if possible, else block, else build; the centre on
 * an empty board. Simple line scoring, not a strong engine.
 */
export function gomokuMove(board: number[], size: number, me: number): [number, number] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? -1 : board[y * size + x]);
  if (!board.some((c) => c)) return [Math.floor(size / 2), Math.floor(size / 2)];
  const run = (x: number, y: number, c: number) => {
    let score = 0;
    for (const [dx, dy] of DIRS) {
      let n = 1;
      let open = 0;
      for (const sgn of [1, -1]) {
        let k = 1;
        while (at(x + sgn * dx * k, y + sgn * dy * k) === c) {
          n++;
          k++;
        }
        if (at(x + sgn * dx * k, y + sgn * dy * k) === 0) open++;
      }
      if (n >= 5) score += 1e6;
      else score += Math.pow(10, n) * (open === 2 ? 2 : open === 1 ? 1 : 0.1);
    }
    return score;
  };
  let best: [number, number] = [-1, -1];
  let bestScore = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (at(x, y) !== 0) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) near = at(x + dx, y + dy) > 0;
      if (!near) continue;
      // Winning beats blocking: own lines count a little more.
      const sc = run(x, y, me) * 1.1 + run(x, y, 3 - me);
      if (sc > bestScore) {
        bestScore = sc;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Reads a game from the server's JSON (protobuf JSON names, ids as strings). */
export function parseGame(g: {
  id: bigint; convId: bigint; kind: string; hostId: bigint; status: string; autoApprove: boolean;
  players: { userId: bigint; out: boolean; spy: boolean; word: string }[]; applicants: bigint[]; waitingOn: bigint[];
  stateJson: string; createdAt: bigint; updatedAt: bigint;
}): Game {
  let state: GameState = { turn: -1 };
  try {
    state = { ...(JSON.parse(g.stateJson || '{}') as GameState) };
    if (typeof state.turn !== 'number') state.turn = -1;
  } catch {
    /* keep empty */
  }
  return {
    id: String(g.id), convId: String(g.convId), kind: g.kind as GameKind, hostId: String(g.hostId),
    status: g.status as Game['status'], autoApprove: g.autoApprove,
    players: g.players.map((p) => ({ userId: String(p.userId), out: p.out, spy: p.spy, word: p.word })),
    applicants: g.applicants.map(String), waitingOn: g.waitingOn.map(String), state,
    createdAt: Number(g.createdAt), updatedAt: Number(g.updatedAt),
  };
}
