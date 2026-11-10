// The camera QR scanner (lib/qrScan.ts): full screen, the back camera, a
// frame to aim with; every ~150 ms a frame goes through jsQR. Closes on the
// first code, with ✕ or the back button.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CameraOff, X } from 'lucide-react';
import jsQR from 'jsqr';
import { cameraError, finishScan, useQrScan } from '@/lib/qrScan';
import { useBack } from '@/lib/back';
import { ease } from '@/ui';

export function QrScannerHost() {
  const open = useQrScan((s) => !!s.resolve);
  return <AnimatePresence>{open && <Scanner key="scanner" />}</AnimatePresence>;
}

function Scanner() {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useBack(true, () => finishScan(null));
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer = 0;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('这个系统的网页组件不支持相机'), { name: 'NotSupported' });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        if (!stopped) setError(cameraError(e));
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const tick = () => {
        if (stopped) return;
        if (v.videoWidth) {
          const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
          canvas.width = Math.round(v.videoWidth * scale);
          canvas.height = Math.round(v.videoHeight * scale);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (code?.data) {
            navigator.vibrate?.(40);
            finishScan(code.data);
            return;
          }
        }
        timer = window.setTimeout(tick, 150);
      };
      tick();
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <motion.div
      role="dialog"
      aria-label="扫一扫"
      className="fixed inset-0 z-50 overflow-hidden bg-black text-white"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={ease}
    >
      <video ref={video} className="absolute inset-0 h-full w-full object-cover" playsInline muted />
      {/* The aiming frame: the rest of the picture is dimmed. */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative aspect-square w-[68vw] max-w-[320px] rounded-3xl shadow-[0_0_0_100vmax_rgba(0,0,0,0.5)]">
          {(['top-0 left-0 border-t-4 border-l-4 rounded-tl-3xl', 'top-0 right-0 border-t-4 border-r-4 rounded-tr-3xl', 'bottom-0 left-0 border-b-4 border-l-4 rounded-bl-3xl', 'bottom-0 right-0 border-b-4 border-r-4 rounded-br-3xl'] as const).map((c) => (
            <span key={c} className={`absolute h-10 w-10 border-white ${c}`} />
          ))}
          {!error && (
            <motion.span
              className="absolute inset-x-4 h-0.5 rounded-full bg-gradient-to-r from-transparent via-white to-transparent"
              animate={{ top: ['8%', '92%', '8%'] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: [0.45, 0, 0.55, 1] }}
            />
          )}
        </div>
      </div>
      <div className="absolute inset-x-0 flex items-center px-3" style={{ top: 'calc(var(--safe-top, 0px) + 0.75rem)' }}>
        <button onClick={() => finishScan(null)} aria-label="关闭" className="press flex h-11 w-11 items-center justify-center rounded-full bg-black/40 backdrop-blur"><X size={22} /></button>
        <span className="flex-1 text-center text-[1.05rem] font-semibold">扫一扫</span>
        <span className="w-11" />
      </div>
      <div className="absolute inset-x-6 text-center text-[0.9rem]" style={{ bottom: 'calc(var(--safe-bottom, 0px) + 3rem)' }}>
        {error ? (
          <div className="mx-auto flex max-w-sm flex-col items-center gap-2 rounded-2xl bg-black/60 p-4" role="alert">
            <CameraOff size={26} />
            <span>{error}</span>
          </div>
        ) : (
          <span className="rounded-full bg-black/40 px-4 py-2 backdrop-blur">把加入码或登录码的二维码放进框里</span>
        )}
      </div>
    </motion.div>
  );
}
