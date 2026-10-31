// Run with: npm test
import assert from 'node:assert/strict';
import { bySource, copyParts, layoutMedia, markChanged, memoryCache, remapLayout, type SyncSide } from './profileSync.ts';
import type { LayoutModel } from './widgets.ts';
import type { Activity } from './types.ts';

const board = (): LayoutModel => ({
  widgets: [
    { id: 'w1', kind: 'image', source: 'builtin', w: 2, h: 2, land: { page: 0, x: 0, y: 0 }, config: { media_id: '11' }, contentEditors: 'everyone' },
    { id: 'w2', kind: 'gallery', source: 'builtin', w: 2, h: 2, land: { page: 0, x: 2, y: 0 }, config: { media_ids: ['12', '13'] }, contentEditors: 'everyone' },
    { id: 'w3', kind: 'text', source: 'builtin', w: 1, h: 1, land: { page: 0, x: 4, y: 0 }, config: { text: 'hi' }, contentEditors: 'everyone' },
  ],
  portraitCustom: false,
  background: { kind: 'image', value: '', mediaId: '14', blur: 0, dim: 0 },
  version: 3,
});

// layoutMedia: every picture once
assert.deepEqual(layoutMedia(board()).sort(), ['11', '12', '13', '14']);

// remapLayout: ids replaced, unknown ones dropped, image background without a copy cleared
const r = remapLayout(board(), { '11': 'a', '12': 'b', '14': 'd' });
assert.equal(r.widgets[0].config.media_id, 'a');
assert.deepEqual(r.widgets[1].config.media_ids, ['b']);
assert.deepEqual(r.widgets[2].config, { text: 'hi' });
assert.equal(r.background.mediaId, 'd');
const r2 = remapLayout(board(), {});
assert.equal(r2.background.kind, '');
assert.equal(r2.widgets[0].config.media_id, '');

// markChanged: newest change wins, nothing copied back onto its source
let p = markChanged({}, 'A', ['profile'], ['A', 'B', 'C'], 1);
assert.deepEqual(p, { B: { profile: { from: 'A', at: 1 } }, C: { profile: { from: 'A', at: 1 } } });
p = markChanged(p, 'B', ['profile', 'board'], ['A', 'B', 'C'], 2);
assert.deepEqual(p, {
  A: { profile: { from: 'B', at: 2 }, board: { from: 'B', at: 2 } },
  C: { profile: { from: 'B', at: 2 }, board: { from: 'B', at: 2 } },
});
assert.deepEqual(bySource({ profile: { from: 'B', at: 2 }, presence: { from: 'C', at: 3 }, board: { from: 'B', at: 2 } }), { B: ['profile', 'board'], C: ['presence'] });

// copyParts with two fake servers
function fake(id: string, ids: string[]) {
  const media = new Map<string, Blob>();
  let next = 100;
  const s = {
    uploads: 0,
    profile: { name: '', bio: '', avatar: undefined as string | undefined },
    pres: { invisible: false, activity: undefined as Activity | undefined },
    layout: { widgets: [], portraitCustom: false, background: { kind: '', value: '', blur: 0, dim: 0 }, version: 7 } as LayoutModel,
    side: undefined as unknown as SyncSide,
  };
  for (const m of ids) media.set(m, new Blob([id + m]));
  s.side = {
    id,
    me: () => s.profile,
    presence: () => s.pres,
    getBoard: async () => s.layout,
    saveBoard: async (l) => {
      for (const m of layoutMedia(l)) if (!media.has(m)) throw Object.assign(new Error('文件不存在'), { code: 'media_not_found' });
      s.layout = { ...l, version: l.version + 1 };
    },
    setProfile: async (v) => {
      s.profile = { name: v.displayName, bio: v.bio, avatar: v.avatarMediaId && v.avatarMediaId !== '0' ? `/api/v1/media/${v.avatarMediaId}` : undefined };
    },
    setPresence: async (invisible, activity) => void (s.pres = { invisible, activity }),
    mediaBytes: async (path) => {
      const b = media.get(path.split('/').pop()!);
      if (!b) throw new Error('missing');
      return b;
    },
    upload: async (blob) => {
      s.uploads++;
      const out = String(next++);
      media.set(out, blob);
      return out;
    },
  };
  return s;
}

const A = fake('A', ['11', '12', '13', '14', '20']);
A.profile = { name: '小明', bio: '你好', avatar: '/api/v1/media/20' };
A.pres = { invisible: true, activity: { kind: 'playing', text: '原神' } };
A.layout = board();
const B = fake('B', []);
const cache = memoryCache();

await copyParts(A.side, B.side, ['profile', 'presence', 'board'], cache);
assert.equal(B.profile.name, '小明');
assert.equal(B.profile.bio, '你好');
assert.ok(B.profile.avatar?.startsWith('/api/v1/media/1'));
assert.deepEqual(B.pres, A.pres);
assert.equal(B.layout.widgets.length, 3);
assert.equal(B.layout.version, 8); // saved on top of B's own version
assert.equal(B.uploads, 5);
assert.deepEqual(layoutMedia(B.layout).length, 4);
assert.ok(layoutMedia(B.layout).every((m) => Number(m) >= 100));

// Unchanged pictures are not uploaded again
await copyParts(A.side, B.side, ['profile', 'board'], cache);
assert.equal(B.uploads, 5);

// A cached copy that disappeared on the target: one fresh retry uploads again
const C = fake('C', []);
const stale = memoryCache();
for (const m of ['11', '12', '13', '14']) stale.set('A', m, 'C', 'gone' + m);
await copyParts(A.side, C.side, ['board'], stale);
assert.equal(C.uploads, 4);

// No avatar on the source clears it on the target
A.profile = { ...A.profile, avatar: undefined };
await copyParts(A.side, B.side, ['profile'], cache);
assert.equal(B.profile.avatar, undefined);

console.log('profileSync ok');
