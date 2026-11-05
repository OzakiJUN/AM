import type { Pond } from './fishing';
// Board games in channels and shared AI rooms (docs/design.md §13 小游戏):
// the server holds the game and checks the rules (server/internal/game);
// this is the client side's pure part (tested): reading a game, board
// coordinates, the text an AI reads, and a fallback move for AIs whose
// model did not move.

export type GameKind = 'gomoku' | 'reversi' | 'undercover' | 'trail' | 'fishing';

export interface GamePlayer {
  userId: string;
  out: boolean;
  spy: boolean;
  word: string;
}

export interface GameState {
  pond?: Pond;
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
  /** 数字迷踪: everyone's numbers (0 = hidden from me) and every action. */
  hands?: TrailHand[];
  steps?: TrailStep[];
}

export interface TrailHand {
  nums: number[];
  shown: boolean[];
  hinted: boolean[];
}

export interface TrailStep {
  seat: number;
  target: number;
  kind: 'ask' | 'guess';
  q?: TrailQ;
  x: number;
  yes: boolean;
  /** After a wrong guess: which of the guesser's cards had its parity given away (-1 = none). */
  hint: number;
  odd?: boolean;
}

export type TrailQ = 'gt' | 'lt' | 'mult' | 'odd' | 'even';

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

/** 数字迷踪: numbers go from 1 to TRAIL_MAX; the game ends after TRAIL_STEPS actions (server: trail.go). */
export const TRAIL_MAX = 20;
export const TRAIL_STEPS = 90;

export const GAME_INFO: Record<GameKind, { name: string; players: string; min: number; max: number; rules: string }> = {
  fishing: {
    name: '星屿鱼塘', players: '1–12 人 · 不限时', min: 1, max: 12,
    rules: '方形鱼塘 12 个座位，坐下自动抛竿，鱼上钩立即由服务端自动入篓并再次抛竿，无需点击或等待收获窗口。100 种鱼各有平均长度，鱼种越稀有越难遇见，鱼的长度是精确到 0.01 米的连续数值，越偏长或偏短越罕见，价值由实际长度计算，金币保留两位小数。每次收获还有小概率是钱袋、单张鱼卡或卡包。商店只切换自己的界面，可卖鱼、买工具和卡包。疾风竿缩短等待，双鱼竿有 10/20/30/40/50% 概率一次钓两条独立计价的鱼，钱袋、卡片、卡包与偷来的鱼不触发，点金竿提高鱼价，手套可从本鱼塘其他玩家的鱼篓中转移现有鱼，基础每次1条，共用120秒冷却；多鱼手套五档最多1/2/3/4/5条，疾影手套减冷却10/25/40/60/80%，点金手套提高偷鱼售价15/30/55/90/150%，可单独用或组合，不偷金币、卡片或卡包，结界自动防偷后冷却。七类工具各有五档品质，最多装两类，同类只能装一件。卡包有四张卡，100 种鱼各有铁、铜、银、金、镭射卡，共 500 种，每档收集 25/50/75/100 种分别得 I/II/III/IV 级徽章。人类账号通过客户端跨服同步一份存档，迁移时停止旧服收益，同一存档只能在一个服务器挂机。服务端离线持续托管，手套自动寻找机会，结界自动防偷，满级手套冷却更短且有破盾概率。',
  },
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
  trail: {
    name: '数字迷踪', players: '2–6 人', min: 2, max: 6,
    rules: `每人发 3 个 1–20 之间的数（大家的都不一样），只有自己看得到。轮到你时做一件事：问某个人一个问题（他有没有比 X 大的、比 X 小的、X 的倍数、单数、双数），系统如实回答，大家都看得到；或者猜他的一个数：猜中了那个数就翻开，猜错了你要公开自己一张牌是单数还是双数。数全被翻开的人出局，最后剩下的人赢。${TRAIL_STEPS} 步还没分出胜负时，没翻开的数最多的人赢。`,
  },
};

export const KINDS = Object.keys(GAME_INFO) as GameKind[];

// ---- 数字迷踪 ----

/** The questions, with the range of X (none for odd / even). */
export const TRAIL_QUESTIONS: { q: TrailQ; text: string; label: (x: number) => string; min: number; max: number }[] = [
  { q: 'gt', text: '有没有比 X 大的数', label: (x) => `有没有比 ${x} 大的数`, min: 1, max: TRAIL_MAX - 1 },
  { q: 'lt', text: '有没有比 X 小的数', label: (x) => `有没有比 ${x} 小的数`, min: 2, max: TRAIL_MAX },
  { q: 'mult', text: '有没有 X 的倍数', label: (x) => `有没有 ${x} 的倍数`, min: 2, max: 6 },
  { q: 'odd', text: '有没有单数', label: () => '有没有单数', min: 0, max: 0 },
  { q: 'even', text: '有没有双数', label: () => '有没有双数', min: 0, max: 0 },
];

export const questionText = (q: TrailQ, x: number) => TRAIL_QUESTIONS.find((t) => t.q === q)?.label(x) ?? q;

/** Same rule as the server (server/internal/game/trail.go Answer). */
export function trailAnswer(nums: number[], q: TrailQ, x: number): boolean {
  return nums.some((n) => (q === 'gt' && n > x) || (q === 'lt' && n < x) || (q === 'mult' && n % x === 0) || (q === 'odd' && n % 2 === 1) || (q === 'even' && n % 2 === 0));
}

/** One action as a line: "2号 小鱼 问 1号 Weiqi：有没有比 10 大的数？——有". */
export function stepText(g: Game, st: TrailStep, nameOf: (id: string) => string): string {
  const who = (i: number) => `${i + 1}号 ${nameOf(g.players[i]?.userId ?? '')}`;
  if (st.kind === 'ask') return `${who(st.seat)} 问 ${who(st.target)}：${questionText(st.q!, st.x)}？——${st.yes ? '有' : '没有'}`;
  const tail = st.yes ? '猜中了，翻开' : `没猜中${st.hint >= 0 ? `，${who(st.seat)} 的第 ${st.hint + 1} 张是${st.odd ? '单数' : '双数'}` : ''}`;
  return `${who(st.seat)} 猜 ${who(st.target)} 有 ${st.x}：${tail}`;
}

/** A hand as text from `me`'s view: "7 ? ?(单)"; shown ones marked. */
export function handText(h: TrailHand, mine: boolean): string {
  return h.nums.map((n, i) => {
    if (h.shown[i]) return `[${n}已翻开]`;
    if (mine) return h.hinted[i] ? `${n}(已公开${n % 2 ? '单' : '双'}数)` : String(n);
    return h.hinted[i] ? '?(公开过单双)' : '?';
  }).join(' ');
}

/**
 * What `me` can still know about `target`'s hidden numbers, from everything
 * public plus my own hand: every set of numbers that fits all answers.
 * Returns how many sets fit and, per number, in how many of them it is.
 */
export function trailOptions(st: GameState, mySeat: number, target: number): { sets: number; count: Map<number, number> } {
  const hands = st.hands ?? [];
  const steps = st.steps ?? [];
  const h = hands[target];
  const count = new Map<number, number>();
  if (!h) return { sets: 0, count };
  const k = h.nums.filter((_, i) => !h.shown[i]).length;
  const known = new Set<number>();
  hands.forEach((x, i) => x.nums.forEach((n, j) => { if (x.shown[j] || i === mySeat) known.add(n); }));
  // Numbers guessed wrong on the target are not theirs.
  for (const s of steps) if (s.kind === 'guess' && s.target === target && !s.yes) known.add(s.x);
  const pool: number[] = [];
  for (let n = 1; n <= TRAIL_MAX; n++) if (!known.has(n) && n !== 0) pool.push(n);
  // Parity of the target's hidden hinted cards.
  let odd = 0;
  let even = 0;
  steps.forEach((s) => {
    if (s.kind === 'guess' && !s.yes && s.seat === target && s.hint >= 0 && !h.shown[s.hint]) {
      if (s.odd) odd++;
      else even++;
    }
  });
  // Numbers of the target turned up after each question (they were hidden then).
  const asks = steps.map((s, i) => ({ s, later: steps.slice(i + 1).filter((t) => t.kind === 'guess' && t.yes && t.target === target).map((t) => t.x) }))
    .filter(({ s }) => s.kind === 'ask' && s.target === target);
  let sets = 0;
  const pick: number[] = [];
  const walk = (from: number) => {
    if (pick.length === k) {
      if (pick.filter((n) => n % 2 === 1).length < odd || pick.filter((n) => n % 2 === 0).length < even) return;
      for (const { s, later } of asks) if (trailAnswer([...pick, ...later], s.q!, s.x) !== s.yes) return;
      sets++;
      for (const n of pick) count.set(n, (count.get(n) ?? 0) + 1);
      return;
    }
    for (let i = from; i < pool.length; i++) {
      pick.push(pool[i]);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return { sets, count };
}

/**
 * A sensible 数字迷踪 action for `mySeat` when the model didn't act: guess a
 * number that must be there, else a likely one when few options are left,
 * else ask the question that splits the possibilities best.
 */
export function trailMove(st: GameState, players: GamePlayer[], mySeat: number):
  { action: 'guess'; target: number; x: number } | { action: 'ask'; target: number; q: TrailQ; x: number } {
  let best: { target: number; sets: number; count: Map<number, number> } | null = null;
  for (let t = 0; t < players.length; t++) {
    if (t === mySeat || players[t].out) continue;
    const o = trailOptions(st, mySeat, t);
    for (const [n, c] of o.count) if (o.sets > 0 && c === o.sets) return { action: 'guess', target: t, x: n };
    if (!best || (o.sets > 0 && o.sets < best.sets)) best = { target: t, ...o };
  }
  const t = best?.target ?? players.findIndex((p, i) => i !== mySeat && !p.out);
  if (best && best.sets > 0 && best.sets <= 3) {
    const [n] = [...best.count.entries()].sort((a, b) => b[1] - a[1])[0];
    return { action: 'guess', target: t, x: n };
  }
  // Ask: the question whose answer splits the remaining sets most evenly (estimated on the candidate numbers).
  const cands = best ? [...best.count.keys()] : [];
  let q: { q: TrailQ; x: number; score: number } = { q: 'gt', x: 10, score: Infinity };
  for (const t2 of TRAIL_QUESTIONS) {
    for (let x = t2.min; x <= t2.max; x++) {
      const yes = cands.filter((n) => trailAnswer([n], t2.q, x)).length;
      const score = Math.abs(yes * 2 - cands.length);
      if (score < q.score && yes > 0 && yes < cands.length) q = { q: t2.q, x, score };
    }
  }
  return { action: 'ask', target: t, q: q.q, x: q.x };
}

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
  if (g.kind === 'trail') {
    if (w === -1) return `${TRAIL_STEPS} 步到了，平局`;
    const p = g.players[w - 1];
    return w > 0 ? `${p ? nameOf(p.userId) : '?'} 赢了${st.result === 'steps' ? `（${TRAIL_STEPS} 步到了，剩下的数最多）` : ''}` : '这局结束了';
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
  if (g.kind === 'fishing') {
    lines.push(...(st.pond?.seats ?? []).map((p, i) => `${i + 1}号：${p.user_id === '0' ? '空位' : nameOf(p.user_id) + (p.user_id === me ? '（你）' : '') + (Date.now() >= p.bite_at && Date.now() <= p.expires_at ? '，正在自动收获' : '，等待上钩')}`));
    lines.push('用 fishing_state 查看完整规则、金币、装备和收集，fishing_act 入座或从玩家鱼篓偷鱼（无需等对方上钩，收获自动完成），fishing_shop 管理商店。');
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
  if (g.kind === 'trail') {
    const hands = st.hands ?? [];
    if (seat >= 0 && hands[seat]) lines.push(`你的数：${handText(hands[seat], true)}`);
    g.players.forEach((p, i) => {
      if (i === seat || !hands[i]) return;
      lines.push(`${i + 1}号 ${nameOf(p.userId)}${p.out ? '（已出局）' : ''} 的牌：${hands[i].nums.map((n, k) => (hands[i].shown[k] ? String(n) : hands[i].hinted[k] ? '?（公开过单双）' : '?')).join(' ')}`);
    });
    const steps = (st.steps ?? []).map((x) => stepText(g, x, nameOf));
    if (steps.length) lines.push(`到现在 ${steps.length} 步（最多 ${TRAIL_STEPS} 步）：\n` + steps.join('\n'));
    if (mine) {
      lines.push('轮到你了，二选一：用 game_ask 问某个人一个问题（target 写座位号，question 写 gt / lt / mult / odd / even，x 是数字：gt = 有没有比 x 大的，lt = 比 x 小的，mult = x 的倍数，x 在 2–6），或者用 game_guess 猜某个人的一个数（target 座位号，x 1–20）。从所有问答里推理：别问已经知道答案的问题；能确定的数就直接猜。');
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
