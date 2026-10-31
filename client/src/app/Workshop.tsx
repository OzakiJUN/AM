// 创意工坊 (docs/design.md §13): not built yet. The page says so and what
// is coming, so the nav already has its place.
import { motion } from 'motion/react';
import { Blocks, Gamepad2, Palette, Puzzle, Smile, Store } from 'lucide-react';
import { spring } from '@/ui';

const COMING = [
  { Icon: Palette, title: '主题', text: '配色、背景、毛玻璃效果，一键换一套' },
  { Icon: Puzzle, title: '主页小组件', text: '别人做的小组件，装到自己的主页上' },
  { Icon: Smile, title: '表情包和 AI 形象包', text: '整套表情包、AI 立绘（以后也支持 Live2D）' },
  { Icon: Gamepad2, title: '小游戏', text: '和 AI 一起玩，或者让几个人的 AI 坐一桌玩桌游' },
  { Icon: Blocks, title: 'Bot 和工具', text: '给 AI 用的工具、频道里的 Bot' },
];

export function WorkshopPage() {
  return (
    <section className="glass flex-1 overflow-y-auto rounded-3xl p-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mx-auto max-w-3xl">
        <div className="card flex items-center gap-5 rounded-3xl bg-white/80 p-7 dark:bg-white/[0.05]">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-accent-100 text-accent dark:bg-white/10"><Store size={30} /></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[1.6rem] font-bold">创意工坊</h1>
            <p className="mt-1 text-ink-soft dark:text-white/60">暂时还不能用。</p>
          </div>
          <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-[0.85rem] font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-200">施工中</span>
        </div>
        <div className="mt-5 rounded-2xl bg-black/[0.03] p-5 text-[0.92rem] leading-relaxed dark:bg-white/[0.04]">
          <div className="font-semibold">什么时候能用</div>
          <p className="mt-1 text-ink-soft dark:text-white/60">
            按开发顺序排在第五阶段：先把 AI、自动更新、表情包、社区做完再开工。具体日期还没定，做好会随更新推送，不用另外下载。
            工坊的东西放在 GitHub 上，通过审核的会签名，自己装别人发的文件也行（会提醒你）。
          </p>
        </div>
        <div className="mt-6 mb-2 text-[0.85rem] font-medium text-ink-soft dark:text-white/55">以后这里会有</div>
        <div className="grid grid-cols-2 gap-3">
          {COMING.map(({ Icon, title, text }, i) => (
            <motion.div key={title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.05 * i }}
              className="card lift flex gap-3 rounded-2xl bg-white/70 p-4 dark:bg-white/[0.04]">
              <Icon size={20} className="mt-0.5 shrink-0 text-accent" />
              <div>
                <div className="font-medium">{title}</div>
                <div className="text-[0.82rem] text-ink-soft dark:text-white/50">{text}</div>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
