// Run with: npm test
import assert from 'node:assert/strict';
import { autoPortrait, cellAt, firstFree, fits, freezePortrait, placements, usedPages, type LayoutModel, type WidgetModel } from './widgets.ts';

const W = (id: string, w: number, h: number, page: number, x: number, y: number): WidgetModel => ({
  id, kind: 'text', source: 'builtin', w, h, land: { page, x, y }, config: {}, contentEditors: 'everyone',
});
const layout = (widgets: WidgetModel[]): LayoutModel => ({ widgets, portraitCustom: false, background: { kind: '', value: '', blur: 0, dim: 0 }, version: 1 });

// fits: bounds and overlaps
const ws = [W('a', 2, 2, 0, 0, 0), W('b', 4, 2, 0, 2, 2)];
const pl = placements(layout(ws), 'landscape');
assert.equal(fits(ws, pl, 'landscape', { page: 0, x: 1, y: 1 }, 2, 1), false); // hits a
assert.equal(fits(ws, pl, 'landscape', { page: 0, x: 2, y: 0 }, 4, 2), true);
assert.equal(fits(ws, pl, 'landscape', { page: 0, x: 3, y: 0 }, 4, 1), false); // off the right edge
assert.equal(fits(ws, pl, 'landscape', { page: 3, x: 0, y: 0 }, 1, 1), false); // no 4th page
assert.equal(fits(ws, pl, 'landscape', { page: 0, x: 1, y: 1 }, 1, 1, 'a'), true); // moving a itself

// firstFree: page 0 first, then the next pages
assert.deepEqual(firstFree(ws, pl, 'landscape', 2, 2), { page: 0, x: 2, y: 0 });
const full = [W('a', 4, 4, 0, 0, 0), W('b', 2, 4, 0, 4, 0)];
assert.deepEqual(firstFree(full, placements(layout(full), 'landscape'), 'landscape', 1, 1), { page: 1, x: 0, y: 0 });

// autoPortrait: reading order, first fit (6 wide landscape row -> 4 wide portrait)
const port = autoPortrait([W('b', 4, 2, 0, 2, 2), W('a', 2, 2, 0, 0, 0), W('c', 2, 1, 1, 0, 0)]);
assert.deepEqual(port.get('a'), { page: 0, x: 0, y: 0 });
assert.deepEqual(port.get('b'), { page: 0, x: 0, y: 2 });
assert.deepEqual(port.get('c'), { page: 0, x: 2, y: 0 });

// usedPages skips empty pages
assert.deepEqual(usedPages(new Map([['a', { page: 2, x: 0, y: 0 }], ['b', { page: 0, x: 0, y: 0 }]])), [0, 2]);

// freezePortrait keeps the auto layout and marks it custom
const fz = freezePortrait(layout([W('a', 2, 2, 0, 0, 0), W('c', 2, 1, 1, 0, 0)]));
assert.equal(fz.portraitCustom, true);
assert.deepEqual(fz.widgets.find((w) => w.id === 'c')!.port, { page: 0, x: 2, y: 0 });

// cellAt clamps to the board
assert.deepEqual(cellAt('landscape', 1, 500, -40, 100, 2, 1), { page: 1, x: 4, y: 0 });
console.log('widgets ok');

// widgetKinds helpers
const { neteasePlaylistId, daysUntil } = await import('./widgetKinds.ts');
assert.equal(neteasePlaylistId('https://music.163.com/#/playlist?id=3778678'), '3778678');
assert.equal(neteasePlaylistId('https://y.music.163.com/m/playlist?id=24381616&userid=1'), '24381616');
assert.equal(neteasePlaylistId(' 12345 '), '12345');
assert.equal(neteasePlaylistId('https://example.com/'), '');
const noon = new Date(2026, 9, 30, 12).getTime();
assert.equal(daysUntil(new Date(2026, 9, 31, 1).getTime(), noon), 1);
assert.equal(daysUntil(new Date(2026, 9, 30, 23).getTime(), noon), 0);
assert.equal(daysUntil(new Date(2026, 9, 1).getTime(), noon), -29);
console.log('widget kinds ok');
