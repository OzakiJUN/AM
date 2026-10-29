import { AnimatePresence, motion } from 'motion/react';
import { useApp } from '@/lib/store';
import { AskHost, MenuHost, ToastHost, ease } from '@/ui';
import { Backdrop } from '@/app/Backdrop';
import { Shell } from '@/app/Shell';
import { Welcome } from '@/app/Welcome';

export default function App() {
  const view = useApp((s) => s.view);
  return (
    <>
      <Backdrop />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={view}
          className="h-full"
          initial={{ opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.01, transition: { duration: 0.16 } }}
          transition={ease}
        >
          {view === 'welcome' ? <Welcome /> : <Shell />}
        </motion.div>
      </AnimatePresence>
      <AskHost />
      <MenuHost />
      <ToastHost />
    </>
  );
}
