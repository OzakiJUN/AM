// Run with: npm test
import assert from 'node:assert/strict';
import { trailAnswer, trailMove, trailOptions, type GameState, type TrailStep, boardText, coord, gameText, gomokuMove, parseCoord, resultText, type Game } from './games.ts';

assert.equal(coord(7, 7), 'H8');
assert.deepEqual(parseCoord('H8', 15), [7, 7]);
assert.deepEqual(parseCoord(' h 8 ', 15), [7, 7]);
assert.deepEqual(parseCoord('8H', 15), [7, 7]);
assert.deepEqual(parseCoord('(3, 4)', 8), [3, 4]);
assert.equal(parseCoord('I9', 8), null); // off the 8×8 board
assert.equal(parseCoord('Z1', 15), null);
assert.equal(parseCoord('hello', 15), null);

const empty = Array(225).fill(0);
assert.deepEqual(gomokuMove(empty, 15, 1), [7, 7]);
// Four black in a row with an open end: black takes the win, white blocks it.
const four = [...empty];
for (let x = 3; x < 7; x++) four[7 * 15 + x] = 1;
four[0] = 2;
const win = gomokuMove(four, 15, 1);
assert.ok((win[0] === 7 || win[0] === 2) && win[1] === 7, `win ${win}`);
const block = gomokuMove(four, 15, 2);
assert.ok((block[0] === 7 || block[0] === 2) && block[1] === 7, `block ${block}`);

const st = { size: 3, board: [1, 0, 0, 0, 2, 0, 0, 0, 0], turn: 0, last: [1, 1] };
assert.equal(boardText(st), '    A B C\n 1  ● · ·\n 2  · ○ ·\n 3  · · ·');

const names: Record<string, string> = { a: '小鱼', b: 'Weiqi' };
const nameOf = (id: string) => names[id] ?? id;
const g: Game = {
  id: '9', convId: 'c', kind: 'gomoku', hostId: 'b', status: 'playing', autoApprove: false,
  players: [{ userId: 'b', out: false, spy: false, word: '' }, { userId: 'a', out: false, spy: false, word: '' }],
  applicants: [], waitingOn: ['a'], state: { ...st, size: 15, board: empty, last: [7, 7] }, createdAt: 0, updatedAt: 0,
};
const t = gameText(g, 'a', nameOf);
assert.ok(t.includes('你执白') && t.includes('上一步：H8') && t.includes('轮到你了') && t.includes('2号 小鱼（你）'), t);
assert.ok(!gameText({ ...g, waitingOn: ['b'] }, 'a', nameOf).includes('轮到你了'));
assert.equal(resultText({ ...g, status: 'ended', state: { ...g.state, winner: 2 } }, nameOf), '小鱼（白）赢了');
assert.equal(resultText({ ...g, status: 'ended', state: { ...g.state, winner: 1, result: 'resign' } }, nameOf), 'Weiqi（黑）赢了，对方认输');

const u: Game = {
  ...g, kind: 'undercover', waitingOn: ['a'],
  players: [{ userId: 'b', out: true, spy: false, word: '' }, { userId: 'a', out: false, spy: false, word: '苹果' }],
  state: { turn: 1, phase: 'describe', round: 2, said: [{ seat: 0, round: 1, text: '红色的' }] },
};
const ut = gameText(u, 'a', nameOf);
assert.ok(ut.includes('你的词是「苹果」') && ut.includes('第1轮 1号 Weiqi：红色的') && ut.includes('game_say') && ut.includes('1号（是平民）'), ut);
assert.equal(resultText({ ...u, status: 'ended', players: [u.players[0], { ...u.players[1], spy: true }], state: { turn: -1, winner: 2, words: ['梨', '苹果'] } }, nameOf),
  '卧底赢了，卧底是 小鱼（平民：梨，卧底：苹果）');
console.log('games ok');

// ---- 数字迷踪 ----
{
  const hands = [
    { nums: [3, 8, 15], shown: [false, false, false], hinted: [false, false, false] }, // me
    { nums: [0, 0, 0], shown: [false, false, false], hinted: [false, false, false] }, // really 2 11 19
  ];
  const players = [{ userId: 'a', out: false, spy: false, word: '' }, { userId: 'b', out: false, spy: false, word: '' }];
  const st = (steps: TrailStep[]): GameState => ({ turn: 0, hands, steps });
  // No information: every 3 of the 17 numbers I don't hold.
  assert.equal(trailOptions(st([]), 0, 1).sets, 680);
  // "Nothing bigger than 18" and "something bigger than 17": one of them is exactly 18 — no, 18: >17 and not >18.
  const s1: TrailStep[] = [
    { seat: 0, target: 1, kind: 'ask', q: 'gt', x: 18, yes: false, hint: -1 },
    { seat: 0, target: 1, kind: 'ask', q: 'gt', x: 17, yes: true, hint: -1 },
  ];
  const o = trailOptions(st(s1), 0, 1);
  assert.equal(o.count.get(18), o.sets, '18 must be there');
  assert.deepEqual(trailMove(st(s1), players, 0), { action: 'guess', target: 1, x: 18 });
  // A wrong guess rules the number out; a right one later still counts for earlier questions.
  const s2: TrailStep[] = [{ seat: 0, target: 1, kind: 'guess', x: 5, yes: false, hint: 0, odd: true }];
  assert.equal(trailOptions(st(s2), 0, 1).count.get(5), undefined);
  // Without anything certain the move is a question.
  assert.equal(trailMove(st([]), players, 0).action, 'ask');
  assert.equal(trailAnswer([4, 9], 'mult', 3), true);
  assert.equal(trailAnswer([4, 10], 'odd', 0), false);
  const g: Game = { id: '1', convId: 'c', kind: 'trail', hostId: 'a', status: 'playing', players, applicants: [], autoApprove: true, waitingOn: ['a'], state: st(s1), createdAt: 0, updatedAt: 0 };
  const text = gameText(g, 'a', (id) => (id === 'a' ? '我' : '小鱼'));
  assert.ok(text.includes('你的数：3 8 15') && text.includes('有没有比 18 大的数？——没有') && text.includes('game_guess'), text);
}
