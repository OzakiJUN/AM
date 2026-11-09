// Run with: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fishLook, hash } from './fishArt.ts';

const rules = JSON.parse(readFileSync(new URL('../../../server/internal/game/fishing_rules.json', import.meta.url), 'utf8')) as { catalog: { id: string; shape: string; motif: number; rarity: number }[] };

// Stable: the same species always looks the same.
assert.equal(hash('f001'), hash('f001'));
assert.deepEqual(fishLook(rules.catalog[0]), fishLook(rules.catalog[0]));

// Every species gets its own look: no two share shape + tail + fin + pattern + colour.
const keys = rules.catalog.map((s) => { const l = fishLook(s); return [l.shape, l.tail, l.dorsal, l.pattern, l.hue, l.body].join('|'); });
assert.equal(new Set(keys).size, rules.catalog.length);
// And plenty of variety in each part.
const looks = rules.catalog.map(fishLook);
for (const part of ['tail', 'dorsal', 'pattern', 'shape'] as const) assert.ok(new Set(looks.map((l) => l[part])).size >= 4, part);
assert.ok(new Set(looks.map((l) => l.hue)).size >= 40, 'hues spread');

// The catalogue's shape, motif and rarity are kept; unknown shapes fall back.
const l = fishLook({ id: 'x', shape: 'ray', motif: 8, rarity: 4 });
assert.equal(l.shape, 'ray'); assert.equal(l.pattern, 8); assert.equal(l.rarity, 4);
assert.equal(fishLook({ id: 'x', shape: '???', motif: 99, rarity: 9 }).shape, 'round');
assert.equal(fishLook({ id: 'x', shape: 'long', motif: 99, rarity: 9 }).rarity, 4);
assert.ok(l.seeds.every((n) => n >= 0 && n < 1) && l.seeds.length === 16);
console.log('fish art ok');
