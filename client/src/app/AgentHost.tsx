// While an AI operates this computer: a bar at the top with what it is doing
// and a stop button (F12 works too), and the owner's permission questions
// (docs/design.md §9, 操作电脑).
import { AnimatePresence, motion } from 'motion/react';
import { Hand, OctagonX, ShieldAlert } from 'lucide-react';
import { CATEGORY_LABEL } from '@/lib/ai/agent';
import { stopAgent, useAgent } from '@/lib/ai/agentState';
import { Button, Dialog, spring } from '@/ui';

export function AgentHost() {
  const active = useAgent((s) => s.active);
  const ask = useAgent((s) => s.asks[0]);
  const list = Object.entries(active);
  const risky = ask && CATEGORY_LABEL[ask.category].risky;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2">
        <AnimatePresence>
          {list.map(([key, a]) => (
            <motion.div
              key={key}
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.97 }}
              transition={spring}
              role="status"
              className="glass-strong pointer-events-auto flex max-w-[min(640px,92vw)] items-center gap-3 rounded-2xl px-4 py-2.5 shadow-xl"
            >
              <motion.span animate={{ scale: [1, 1.18, 1] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} className="h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500" />
              <div className="min-w-0 flex-1 text-[0.88rem]">
                <span className="font-semibold">{a.aiName} 正在操作电脑</span>
                <span className="text-ink-soft dark:text-white/55"> · 第 {a.step} 步 · </span>
                <span className="truncate">{a.action}</span>
              </div>
              <Button size="sm" variant="danger" onClick={() => stopAgent(key)}><OctagonX size={15} /> 停止（F12）</Button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <Dialog open={!!ask} onClose={() => ask?.resolve('deny')} title={ask ? `${ask.aiName} 想要${CATEGORY_LABEL[ask.category].name}` : ''} width={480}>
        {ask && (
          <div className="space-y-4">
            <div className="flex gap-3 rounded-2xl bg-black/[0.04] p-3 dark:bg-white/5">
              <Hand size={18} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 text-[0.92rem] break-words whitespace-pre-wrap">{ask.action}</div>
            </div>
            <p className="text-[0.82rem] text-ink-soft dark:text-white/55">是「{ask.speaker}」让它做的。2 分钟不回答就当不允许。</p>
            {risky && (
              <p className="flex gap-2 rounded-xl bg-amber-50 p-2.5 text-[0.8rem] text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
                <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                选「以后都允许」后，它做这类事就不再问你了。{CATEGORY_LABEL[ask.category].hint}。
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => ask.resolve('deny')}>不允许</Button>
              <Button variant="soft" onClick={() => ask.resolve('always')}>以后都允许</Button>
              <Button variant="primary" onClick={() => ask.resolve('once')}>允许这一次</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
