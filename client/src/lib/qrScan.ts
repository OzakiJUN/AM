// 扫一扫 (docs/design.md §5): the camera QR scanner is our own page
// (app/QrScanner.tsx: getUserMedia + jsQR), so it needs no Google Play
// services — most phones sold in China have none, and the ML Kit based
// plugin crashed there. scanQRCamera() opens it and resolves with the text
// (null = closed).
import { create } from 'zustand';

interface ScanState {
  resolve: ((text: string | null) => void) | null;
}

export const useQrScan = create<ScanState>(() => ({ resolve: null }));

export function scanQRCamera(): Promise<string | null> {
  useQrScan.getState().resolve?.(null);
  return new Promise((resolve) => useQrScan.setState({ resolve }));
}

/** The scanner closes with a result (or null). */
export function finishScan(text: string | null) {
  const r = useQrScan.getState().resolve;
  useQrScan.setState({ resolve: null });
  r?.(text);
}

/** What to tell the person when the camera does not open. */
export function cameraError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'AM 没有相机权限：在手机设置 → 应用 → AM → 权限里允许相机，再试一次';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到能用的相机';
  if (name === 'NotReadableError') return '相机被别的应用占着，关掉它再试';
  return '相机打不开：' + String((e as Error)?.message ?? e);
}
