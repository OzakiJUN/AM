// 创意工坊 (docs/design.md §13). For now it holds what ships with the
// client: the board games (open one in a channel from here), the default
// AI portrait pack and the persona templates. Items from other people
// (GitHub index + releases, signed) come later; the page already has the
// categories and the 「已安装」 list they will use.
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bot, Download, Gamepad2, Hash, Image as ImageIcon, Lock, Package, Palette, Puzzle, Sparkles, Store } from 'lucide-react';
import { TEMPLATES } from '@/lib/ai/persona';
import { DEFAULT_PACK } from '@/lib/defaultPack';
import { GAME_INFO, KINDS, type GameKind } from '@/lib/games';
import { MOODS } from '@/lib/portraits';
import { openConv, useApp } from '@/lib/store';
import { Button, Dialog, Segmented, cx, spring } from '@/ui';
import { startGame } from './Games';

type Category = 'all' | 'game' | 'portrait' | 'persona' | 'theme' | 'widget';

interface Item {
  id: string;
  category: Exclude<Category, 'all'>;
  name: string;
  text: string;
  detail: string;
  game?: GameKind;
}

const CATEGORIES: { value: Category; label: string; Icon: typeof Store }[] = [
  { value: 'all', label: '全部', Icon: Store },
  { value: 'game', label: '小游戏', Icon: Gamepad2 },
  { value: 'portrait', label: 'AI 形象包', Icon: ImageIcon },
  { value: 'persona', label: '人格', Icon: Bot },
  { value: 'theme', label: '主题', Icon: Palette },
  { value: 'widget', label: '主页组件', Icon: Puzzle },
];

const GAME_TEXT: Record<GameKind, string> = {
  gomoku: '两个人轮流下，先连五个的赢。AI 也会下（不算很强）。',
  reversi: '夹住就翻，最后子多的赢。和 AI 下正合适。',
  undercover: '4–8 个人（AI 也算）各拿一个词，轮流描述、投票找卧底。',
};

/** Everything that ships with the client (always installed). */
const BUILT_IN: Item[] = [
  ...KINDS.map((k): Item => ({ id: `game:${k}`, category: 'game', name: GAME_INFO[k].name, text: GAME_TEXT[k], detail: GAME_INFO[k].rules, game: k })),
  {
    id: 'portrait:default', category: 'portrait', name: '默认立绘',
    text: `没有自己形象包的 AI 都用这套（${MOODS.length} 种情绪）`,
    detail: '给自己的 AI 换立绘：AI 设置 →「资料」→「立绘（形象包）」，按情绪命名的一组图片一次导入。',
  },
  ...TEMPLATES.map((t): Item => ({
    id: `persona:${t.key}`, category: 'persona', name: t.name, text: t.persona.intro,
    detail: '新建 AI 时选它当起始人格，或者在 AI 设置 →「人格」里一键换成它。',
  })),
];

export function WorkshopPage() {
  const [tab, setTab] = useState<'browse' | 'installed'>('browse');
  const [cat, setCat] = useState<Category>('all');
  const [item, setItem] = useState<Item | null>(null);
  const list = useMemo(() => BUILT_IN.filter((x) => cat === 'all' || x.category === cat), [cat]);
  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mx-auto max-w-4xl">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent-100 text-accent dark:bg-white/10"><Store size={24} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.5rem] font-bold">创意工坊</h1>
            <p className="text-[0.88rem] text-ink-soft dark:text-white/55">小游戏、AI 形象包、人格、主题、主页组件</p>
          </div>
          <Segmented id="workshop-tab" value={tab} onChange={setTab} options={[{ value: 'browse', label: '发现' }, { value: 'installed', label: `已安装 ${BUILT_IN.length}` }]} />
        </div>

        <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="分类">
          {CATEGORIES.map(({ value, label, Icon }) => (
            <button key={value} role="tab" aria-selected={cat === value} onClick={() => setCat(value)}
              className={cx('press flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[0.88rem] transition-colors duration-200',
                cat === value ? 'bg-accent text-white shadow-[0_6px_16px_-8px_var(--accent)]' : 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/10')}>
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>

        {tab === 'browse' && (
          <div className="mt-4 flex gap-3 rounded-2xl bg-black/[0.03] p-4 text-[0.85rem] leading-relaxed text-ink-soft dark:bg-white/[0.04] dark:text-white/55">
            <Download size={18} className="mt-0.5 shrink-0 text-accent" />
            <span>现在只有软件自带的东西。别人做的作品以后从 GitHub 下载（审核过的有签名，自己装别人发的文件也行，会提醒你）。</span>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          <motion.div key={`${tab}:${cat}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}
            className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((x, i) => (
              <motion.button key={x.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.03 * i }}
                onClick={() => setItem(x)} aria-label={x.name}
                className="card lift flex flex-col gap-2 rounded-2xl bg-white/75 p-4 text-left dark:bg-white/[0.05]">
                <Cover item={x} />
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-semibold">{x.name}</span>
                  <span className="shrink-0 rounded-md bg-emerald-100 px-1.5 text-[0.7rem] leading-5 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200">{tab === 'installed' ? '内置' : '已安装'}</span>
                </div>
                <div className="line-clamp-2 text-[0.82rem] text-ink-soft dark:text-white/50">{x.text}</div>
              </motion.button>
            ))}
            {!list.length && (
              <div className="col-span-full flex flex-col items-center gap-2 py-14 text-center text-ink-soft dark:text-white/50">
                <Package size={26} />
                <span>{cat === 'theme' ? '主题以后从工坊下载；现在可以在 设置 → 外观 里自己调。' : '这一类还没有东西，以后从 GitHub 下载。'}</span>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
      <Dialog open={!!item} onClose={() => setItem(null)} title={item?.name} width={520}>
        {item && <Detail item={item} onDone={() => setItem(null)} />}
      </Dialog>
    </section>
  );
}

function Cover({ item }: { item: Item }) {
  if (item.category === 'portrait') {
    return (
      <div className="flex h-24 items-end justify-center gap-1 overflow-hidden rounded-xl bg-gradient-to-br from-accent-100 to-violet-100 dark:from-accent/20 dark:to-violet-500/20">
        {(['happy', 'neutral', 'shy'] as const).map((m) => DEFAULT_PACK[m] && <img key={m} src={DEFAULT_PACK[m]} alt="" className="h-full object-contain" draggable={false} />)}
      </div>
    );
  }
  const Icon = item.category === 'game' ? Gamepad2 : item.category === 'persona' ? Sparkles : Package;
  const bg = item.game === 'gomoku' ? 'from-amber-200 to-orange-300' : item.game === 'reversi' ? 'from-emerald-300 to-teal-500' : item.game ? 'from-rose-300 to-violet-400' : 'from-accent-200 to-violet-300';
  return (
    <div className={cx('flex h-24 items-center justify-center rounded-xl bg-gradient-to-br text-white', bg)}>
      <Icon size={34} />
    </div>
  );
}

function Detail({ item, onDone }: { item: Item; onDone: () => void }) {
  const serverId = useApp((s) => s.currentId ?? '');
  const v = useApp((s) => s.sessions[serverId]);
  // Channels and shared AI rooms I'm in: where a game can be opened.
  const places = useMemo(() => Object.values(v?.convs ?? {}).filter((c) => c.kind === 'group' && !c.left).sort((a, b) => b.lastTime - a.lastTime), [v?.convs]);
  const [where, setWhere] = useState('');
  const target = where || places[0]?.id || '';
  return (
    <div className="space-y-4">
      <Cover item={item} />
      <p className="text-[0.92rem] leading-relaxed">{item.detail}</p>
      {item.game && (
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
      )}
    </div>
  );
}
