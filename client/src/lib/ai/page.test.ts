// Run with: npm test
import assert from 'node:assert/strict';
import { describePage, editPage } from './page.ts';
import type { LayoutModel } from '../widgets.ts';

let n = 0;
const id = () => `w${++n}`;
const empty: LayoutModel = { widgets: [], portraitCustom: false, background: { kind: '', value: '', blur: 0, dim: 0 }, version: 1 };
const ok = (r: LayoutModel | string): LayoutModel => {
  assert.equal(typeof r, 'object', String(r));
  return r as LayoutModel;
};

// Adding finds a free spot; a chosen spot must fit.
let l = ok(editPage(empty, { action: 'add', kind: 'text', config: { title: '你好', text: '我是小鱼' } }, id));
assert.deepEqual(l.widgets[0].land, { page: 0, x: 0, y: 0 });
assert.equal(l.widgets[0].config.title, '你好');
l = ok(editPage(l, { action: 'add', kind: 'countdown', config: { title: '圣诞', date: '2026-12-25' } }, id));
assert.ok((l.widgets[1].config.date as number) > 0);
assert.notDeepEqual(l.widgets[1].land, l.widgets[0].land);
assert.equal(typeof editPage(l, { action: 'add', kind: 'text', x: 0, y: 0 }, id), 'string'); // overlaps
assert.equal(typeof editPage(l, { action: 'add', kind: 'image' }, id), 'string'); // needs an upload: not offered
// Sizes are clamped to the kind's minimum and 4.
l = ok(editPage(l, { action: 'add', kind: 'guestbook', w: 1, h: 9 }, id));
assert.deepEqual([l.widgets[2].w, l.widgets[2].h], [2, 4]);
// Change, move, remove, background.
l = ok(editPage(l, { action: 'update', id: 'w1', config: { text: '新的自我介绍' } }, id));
assert.deepEqual(l.widgets[0].config, { title: '你好', text: '新的自我介绍' });
l = ok(editPage(l, { action: 'move', id: 'w1', page: 1, x: 2, y: 1 }, id));
assert.deepEqual(l.widgets[0].land, { page: 1, x: 2, y: 1 });
l = ok(editPage(l, { action: 'remove', id: 'w2' }, id));
assert.equal(l.widgets.length, 2);
assert.equal(typeof editPage(l, { action: 'remove', id: 'nope' }, id), 'string');
l = ok(editPage(l, { action: 'background', background: { kind: 'gradient', value: 'sakura' } }, id));
assert.equal(l.background.value, 'sakura');
assert.equal(typeof editPage(l, { action: 'background', background: { kind: 'color', value: 'red' } }, id), 'string');
const text = describePage(l);
assert.ok(text.includes('[w1] 文字卡片（text）2×2，第 1 页 x=2 y=1') && text.includes('gradient sakura') && text.includes('netease_link'), text);
console.log('ai page ok');
