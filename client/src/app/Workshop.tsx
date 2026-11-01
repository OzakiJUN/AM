// 创意工坊 (docs/design.md §13). 「发现」: what ships with the client plus
// the works in the workshop index (GitHub OzakiJUN/am-workshop, signed;
// downloads are checked by SHA-256). 「已安装」: built-ins and what this
// device installed, with 套用 / 导入 / 删除, and 「从文件安装」 for
// unreviewed packages (with a warning). Logic: lib/workshop.ts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle, Bot, Download, ExternalLink, FileUp, Gamepad2, Hash, Image as ImageIcon, Lock, Package, Palette, Puzzle, RefreshCw,
  Search, Settings2, Sparkles, Sticker, Store, Trash2,
} from 'lucide-react';
import { DEFAULT_PACK } from '@/lib/defaultPack';
import { openUrl } from '@/lib/platform';
import { usePrefs } from '@/lib/prefs';
import { importStickerFiles } from '@/lib/stickers';
import {
  CATEGORY_NAME, applyTheme, install, installFile, installState, previewUrl, refreshIndex, stickerFiles, uninstall, useWorkshop,
  workshopReady, type WorkshopCategory, type WorkshopItem,
} from '@/lib/workshop';
import type { IndexItem } from '@/lib/workshopIndex';
import { openConv, useApp } from '@/lib/store';
import { Button, Dialog, Input, Segmented, ask, cx, spring, toast } from '@/ui';
import { startGame } from './Games';

type Category = 'all' | WorkshopCategory;

/** A card: something installed / built in, or a work from the index. */
type Entry = { kind: 'local'; item: WorkshopItem } | { kind: 'index'; item: IndexItem };

const CATEGORIES: { value: Category; label: string; Icon: typeof Store }[] = [
  { value: 'all', label: '全部', Icon: Store },
  { value: 'game', label: '小游戏', Icon: Gamepad2 },
  { value: 'portrait', label: 'AI 形象包', Icon: ImageIcon },
  { value: 'persona', label: '人格', Icon: Bot },
  { value: 'theme', label: '主题', Icon: Palette },
  { value: 'stickers', label: '表情包', Icon: Sticker },
  { value: 'widget', label: '主页组件', Icon: Puzzle },
];

const entryId = (e: Entry) => (e.kind === 'local' ? e.item.id : `idx:${e.item.id}`);
const entryCat = (e: Entry): WorkshopCategory => (e.kind === 'local' ? e.item.category : e.item.type);
const entryName = (e: Entry) => e.item.name;
const entryText = (e: Entry) => (e.kind === 'local' ? e.item.text : e.item.summary);

export function WorkshopPage() {
  const [tab, setTab] = useState<'browse' | 'installed'>('browse');
  const [cat, setCat] = useState<Category>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Entry | null>(null);
  const installed = useWorkshop((s) => s.installed);
  const index = useWorkshop((s) => s.index);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mirrorOpen, setMirrorOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      await refreshIndex();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (workshopReady()) void load();
  }, []);

  const entries = useMemo((): Entry[] => {
    const local: Entry[] = installed.filter((x) => x.builtin || tab === 'installed').map((item) => ({ kind: 'local', item }));
    const remote: Entry[] = tab === 'browse' ? (index?.items ?? []).filter((x) => !x.disabled).map((item) => ({ kind: 'index', item })) : [];
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...local, ...remote].filter((e) => (cat === 'all' || entryCat(e) === cat)
      && words.every((w) => `${entryName(e)} ${entryText(e)} ${e.kind === 'index' ? e.item.author : ''}`.toLowerCase().includes(w)));
  }, [installed, index, tab, cat, q]);

  const pickFile = async (f: File) => {
    await ask({
      title: '安装没审核过的作品？',
      text: `「${f.name}」不是从工坊下载的，没有人检查过它。只装你信得过的人发给你的文件。（主题、形象包、人格、表情包只是图片和文字，不会运行程序。）`,
      ok: '仍然安装', danger: true,
      run: async () => {
        const m = await installFile(f);
        toast(`装好了：${m.name}`);
        setTab('installed');
      },
    });
  };

  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-100 text-accent dark:bg-white/10"><Store size={24} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.5rem] font-bold">创意工坊</h1>
            <p className="text-[0.88rem] text-ink-soft dark:text-white/55">主题、AI 形象包、人格、表情包、小游戏</p>
          </div>
          <Segmented id="workshop-tab" value={tab} onChange={setTab} options={[{ value: 'browse', label: '发现' }, { value: 'installed', label: `已安装 ${installed.length}` }]} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="分类">
          {CATEGORIES.map(({ value, label, Icon }) => (
            <button key={value} role="tab" aria-selected={cat === value} onClick={() => setCat(value)}
              className={cx('press flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[0.88rem] transition-colors duration-200',
                cat === value ? 'bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/10')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-soft" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜名字、介绍、作者" aria-label="搜作品"
              className="h-9 w-full rounded-xl bg-black/[0.04] pr-3 pl-9 text-[0.88rem] outline-none focus:ring-2 focus:ring-accent/40 dark:bg-white/[0.06]" />
          </div>
          {tab === 'browse' ? (
            <>
              <Button size="sm" variant="ghost" loading={loading} disabled={!workshopReady()} onClick={load}><RefreshCw size={14} /> 刷新</Button>
              <Button size="sm" variant="ghost" onClick={() => setMirrorOpen(true)}><Settings2 size={14} /> 下载设置</Button>
            </>
          ) : (
            <Button size="sm" variant="soft" onClick={() => file.current?.click()}><FileUp size={14} /> 从文件安装</Button>
          )}
          <input ref={file} type="file" accept=".zip,application/zip" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickFile(f); }} />
        </div>

        {tab === 'browse' && (!workshopReady() || error) && (
          <div className="mt-4 flex gap-3 rounded-2xl bg-amber-50 p-4 text-[0.85rem] leading-relaxed text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <span>{!workshopReady() ? '工坊还在准备（签名密钥还没设置好），现在只有软件自带的东西。别人发给你的作品文件可以在「已安装」里「从文件安装」。' : `没拿到工坊列表：${error}`}</span>
          </div>
        )}
        {tab === 'browse' && workshopReady() && !error && index && !index.items.length && (
          <div className="mt-4 flex gap-3 rounded-2xl bg-black/[0.03] p-4 text-[0.85rem] text-ink-soft dark:bg-white/[0.04] dark:text-white/55">
            <Download size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>工坊里还没有别人的作品。想发布自己的？看 GitHub 上 OzakiJUN/am-workshop 的发布说明。</span>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          <motion.div key={`${tab}:${cat}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {entries.map((e, i) => (
              <motion.button key={entryId(e)} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: Math.min(0.03 * i, 0.4) }}
                onClick={() => setOpen(e)} aria-label={entryName(e)}
                className="card lift flex flex-col gap-2 rounded-2xl bg-white/75 p-4 text-left dark:bg-white/[0.05]">
                <Cover entry={e} />
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{entryName(e)}</span>
                  <Badge entry={e} />
                </div>
                <div className="line-clamp-2 text-[0.82rem] text-ink-soft dark:text-white/50">{entryText(e)}</div>
              </motion.button>
            ))}
            {!entries.length && (
              <div className="col-span-full flex flex-col items-center gap-2 py-14 text-center text-ink-soft dark:text-white/50">
                <Package size={26} />
                <span>{loading ? '正在拿工坊列表…' : q ? '没有找到' : tab === 'installed' ? '这一类还没有装东西。' : '这一类还没有作品。'}</span>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open ? entryName(open) : ''} width={520}>
        {open && <Detail entry={open} onDone={() => setOpen(null)} />}
      </Dialog>
      <MirrorDialog open={mirrorOpen} onClose={() => setMirrorOpen(false)} />
    </section>
  );
}

function Badge({ entry }: { entry: Entry }) {
  useWorkshop((s) => s.metas); // re-render on install / remove
  let text = '';
  let tone = 'bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200';
  if (entry.kind === 'local') {
    const m = entry.item.installed;
    if (entry.item.builtin) text = '内置';
    else if (m?.disabled) [text, tone] = ['已下架', 'bg-rose-100 text-rose-700 dark:bg-rose-400/15 dark:text-rose-200'];
    else if (m?.source === 'sideload') [text, tone] = ['未审核', 'bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-200'];
    else text = '已安装';
  } else {
    const st = installState(entry.item);
    if (st === 'none') return null;
    if (st === 'update') [text, tone] = ['有更新', 'bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-200'];
    else text = '已安装';
  }
  return <span className={cx('shrink-0 rounded-md px-1.5 text-[0.7rem] leading-5', tone)}>{text}</span>;
}

function Preview({ url }: { url: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    previewUrl(url).then((u) => alive && setSrc(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [url]);
  return src ? <img src={src} alt="" className="h-full w-full object-cover" draggable={false} /> : null;
}

const CAT_ICON: Partial<Record<WorkshopCategory, typeof Store>> = { game: Gamepad2, persona: Sparkles, theme: Palette, stickers: Sticker, portrait: ImageIcon };

function Cover({ entry }: { entry: Entry }) {
  const cat = entryCat(entry);
  if (entry.kind === 'index' && entry.item.preview) {
    return <div className="h-24 overflow-hidden rounded-xl bg-gradient-to-br from-accent-100 to-violet-100 dark:from-accent/20 dark:to-violet-500/20"><Preview url={entry.item.preview} /></div>;
  }
  if (entry.kind === 'local' && entry.item.id === 'portrait:default') {
    return (
      <div className="flex h-24 items-end justify-center gap-1 overflow-hidden rounded-xl bg-gradient-to-br from-accent-100 to-violet-100 dark:from-accent/20 dark:to-violet-500/20">
        {(['happy', 'neutral', 'shy'] as const).map((m) => DEFAULT_PACK[m] && <img key={m} src={DEFAULT_PACK[m]} alt="" className="h-full object-contain" draggable={false} />)}
      </div>
    );
  }
  const Icon = CAT_ICON[cat] ?? Package;
  const game = entry.kind === 'local' ? entry.item.game : undefined;
  const bg = game === 'gomoku' ? 'from-amber-200 to-orange-300' : game === 'reversi' ? 'from-emerald-300 to-teal-500' : game ? 'from-rose-300 to-violet-400'
    : cat === 'theme' ? 'from-sky-300 to-violet-400' : cat === 'stickers' ? 'from-yellow-200 to-rose-300' : 'from-accent-200 to-violet-300';
  return (
    <div className={cx('flex h-24 items-center justify-center rounded-xl bg-gradient-to-br text-white', bg)}>
      <Icon size={34} />
    </div>
  );
}

function Detail({ entry, onDone }: { entry: Entry; onDone: () => void }) {
  if (entry.kind === 'index') return <IndexDetail item={entry.item} />;
  const item = entry.item;
  if (item.game) return <GameDetail item={item} onDone={onDone} />;
  return <LocalDetail item={item} onDone={onDone} />;
}

const fmtSize = (n: number) => (n < 1 << 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1 << 20)).toFixed(1)} MB`);

function IndexDetail({ item }: { item: IndexItem }) {
  useWorkshop((s) => s.metas);
  const st = installState(item);
  const go = async () => {
    const m = await install(item);
    toast(st === 'update' ? `更新好了：${m.name} ${m.version}` : `装好了：${m.name}`);
  };
  return (
    <div className="space-y-4">
      <Cover entry={{ kind: 'index', item }} />
      <p className="text-[0.92rem] leading-relaxed">{item.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.84rem]">
        <dt className="text-ink-soft dark:text-white/50">类型</dt><dd>{CATEGORY_NAME[item.type]}</dd>
        <dt className="text-ink-soft dark:text-white/50">作者</dt><dd>{item.author}</dd>
        <dt className="text-ink-soft dark:text-white/50">版本</dt><dd>{item.version}</dd>
        <dt className="text-ink-soft dark:text-white/50">大小</dt><dd>{fmtSize(item.size)}</dd>
      </dl>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => openUrl(`https://github.com/${item.repo}`)}><ExternalLink size={15} /> 看源码</Button>
        {st === 'installed'
          ? <span className="text-[0.85rem] text-emerald-600 dark:text-emerald-300">已安装，到「已安装」里用它</span>
          : <Button variant="primary" onClick={go}><Download size={15} /> {st === 'update' ? '更新' : '安装'}</Button>}
      </div>
      <p className="text-[0.75rem] text-ink-soft dark:text-white/40">工坊审核过，有签名；下载后会核对文件，被改过的装不上。</p>
    </div>
  );
}

function LocalDetail({ item, onDone }: { item: WorkshopItem; onDone: () => void }) {
  const m = item.installed;
  const serverId = useApp((s) => s.currentId ?? '');
  const online = useApp((s) => s.sessions[serverId]?.status === 'online');
  const [progress, setProgress] = useState('');
  const importStickers = async () => {
    const list = await stickerFiles(m!.id);
    setProgress(`0/${list.length}`);
    try {
      const n = await importStickerFiles(serverId, list, (d) => setProgress(`${d}/${list.length}`));
      toast(`导入了 ${n} 个表情到「我的表情」`);
    } finally {
      setProgress('');
    }
  };
  return (
    <div className="space-y-4">
      <Cover entry={{ kind: 'local', item }} />
      {m?.description && <p className="whitespace-pre-wrap text-[0.9rem] leading-relaxed">{m.description}</p>}
      <p className="text-[0.88rem] leading-relaxed text-ink-soft dark:text-white/60">{item.detail}</p>
      {m && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.84rem]">
          <dt className="text-ink-soft dark:text-white/50">作者</dt><dd>{m.author}</dd>
          <dt className="text-ink-soft dark:text-white/50">版本</dt><dd>{m.version}</dd>
          <dt className="text-ink-soft dark:text-white/50">来源</dt><dd>{m.source === 'workshop' ? '工坊（审核过）' : '从文件安装（没审核过）'}</dd>
        </dl>
      )}
      {m?.disabled && <p className="rounded-xl bg-rose-50 p-3 text-[0.85rem] text-rose-700 dark:bg-rose-400/10 dark:text-rose-200">工坊已经下架了这个作品：{m.disabled}。不能再用它。</p>}
      {m && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => ask({ title: `删除「${m.name}」？`, text: '从这台设备上删掉。已经套用的主题、导入的表情不受影响。', ok: '删除', danger: true, run: async () => { await uninstall(m.id); onDone(); toast('已删除'); } })}>
            <Trash2 size={15} /> 删除
          </Button>
          {m.type === 'theme' && !m.disabled && <Button variant="primary" onClick={() => applyTheme(m.id).then(() => toast('主题换好了（设置 → 外观里还能再调）'))}><Palette size={15} /> 套用</Button>}
          {m.type === 'stickers' && !m.disabled && (
            <Button variant="primary" disabled={!online} loading={!!progress} onClick={importStickers} title={online ? undefined : '先连上一个服务器'}>
              <Sticker size={15} /> {progress ? `导入中 ${progress}` : '导入到我的表情'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function GameDetail({ item, onDone }: { item: WorkshopItem; onDone: () => void }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const v = useApp((s) => s.sessions[serverId]);
  // Channels and shared AI rooms I'm in: where a game can be opened.
  const places = useMemo(() => Object.values(v?.convs ?? {}).filter((c) => c.kind === 'group' && !c.left).sort((a, b) => b.lastTime - a.lastTime), [v?.convs]);
  const [where, setWhere] = useState('');
  const target = where || places[0]?.id || '';
  return (
    <div className="space-y-4">
      <Cover entry={{ kind: 'local', item }} />
      <p className="text-[0.92rem] leading-relaxed">{item.detail}</p>
      <div className="space-y-2">
        <label className="text-[0.85rem] font-medium" htmlFor="game-where">在哪里开局</label>
        {places.length ? (
          <select id="game-where" value={target} onChange={(e) => setWhere(e.target.value)} className="w-full rounded-xl border border-black/10 bg-white/90 px-3 py-2 dark:border-white/10 dark:bg-white/5">
            {places.map((c) => <option key={c.id} value={c.id}>{c.aiId ? '🤖 ' : c.public ? '# ' : '🔒 '}{c.name}</option>)}
          </select>
        ) : <p className="text-[0.85rem] text-ink-soft dark:text-white/50">你还没进任何频道。</p>}
        <p className="flex items-center gap-1.5 text-[0.78rem] text-ink-soft dark:text-white/45">
          <Hash size={13} /> 频道里的人和 AI 都能看到、申请加入；<Lock size={13} /> 你来决定让谁进（也可以设成自动同意）。
        </p>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!target} onClick={async () => {
            await startGame(serverId, target, item.game!);
            openConv(target);
            onDone();
          }}><Gamepad2 size={15} /> 开一局</Button>
        </div>
      </div>
    </div>
  );
}

/** 下载设置: a GitHub mirror for slow connections. */
function MirrorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const prefs = usePrefs();
  const [v, setV] = useState(prefs.workshopMirror);
  useEffect(() => setV(usePrefs.getState().workshopMirror), [open]);
  const ok = !v.trim() || /^https:\/\/[^\s]+$/.test(v.trim());
  return (
    <Dialog open={open} onClose={onClose} title="下载设置" width={460}>
      <div className="space-y-3">
        <p className="text-[0.86rem] leading-relaxed text-ink-soft dark:text-white/60">
          工坊的列表和作品都从 GitHub 下载。国内访问 GitHub 慢或者连不上时，可以填一个 GitHub 下载镜像（加速）地址，下载时用「镜像地址/原地址」。不填就直接连 GitHub。签名和文件校验照样做，镜像改不了内容。
        </p>
        <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="https://镜像地址" aria-label="下载镜像地址" />
        {!ok && <p className="text-[0.8rem] text-rose-500">要以 https:// 开头</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!ok} onClick={() => { prefs.set({ workshopMirror: v.trim() }); onClose(); toast('保存好了'); }}>保存</Button>
        </div>
      </div>
    </Dialog>
  );
}
