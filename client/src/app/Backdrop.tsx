import { useTheme } from '@/lib/theme';

/**
 * Window background: the user's own image (blurred / dimmed as set), or the
 * default soft gradient with blurred light spots tinted by the accent colour.
 */
export function Backdrop() {
  const background = useTheme((s) => s.background);
  if (background) {
    return (
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
        <div
          className="absolute -inset-10 bg-cover bg-center"
          style={{ backgroundImage: `url("${background}")`, filter: 'blur(var(--bg-blur))' }}
        />
        <div className="absolute inset-0 bg-white dark:bg-[#0d0b1c]" style={{ opacity: 'var(--bg-dim)' }} />
      </div>
    );
  }
  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-gradient-to-br from-accent-50 via-[#fbfaff] to-violet-50 dark:from-[#1b1733] dark:via-[#141228] dark:to-[#1d1430]"
      aria-hidden
    >
      <div className="absolute -top-[12%] -left-[8%] h-[520px] w-[520px] rounded-full bg-accent-200/60 blur-[110px] dark:bg-accent/20" />
      <div className="absolute top-[18%] -right-[10%] h-[440px] w-[440px] rounded-full bg-violet-200/60 blur-[100px] dark:bg-violet-500/15" />
      <div className="absolute -bottom-[14%] left-[22%] h-[600px] w-[600px] rounded-full bg-sky-200/45 blur-[120px] dark:bg-sky-500/10" />
    </div>
  );
}
