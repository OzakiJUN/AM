// The Android app's bridge to MainActivity.kt (docs/design.md §5 手机和安卓):
// - the page draws behind the status bar and the gesture bar, padded by
//   their heights (CSS --safe-top / --safe-bottom on <html>, used by #root,
//   full-screen dialogs and the scanner), so the app's own background shows
//   there instead of black strips;
// - the bars' icons are dark on the light theme and light on the dark one;
// - 「后台保持连接」 (prefs.androidKeepAlive) runs KeepAliveService while I
//   have a server;
// - installing a downloaded update (lib/update.ts).
import { usePrefs } from './prefs';
import { useApp } from './store';

export interface AndroidBridge {
  insets(): string;
  setLightBars(light: boolean): void;
  keepAlive(on: boolean): void;
  batteryUnrestricted(): boolean;
  askBatteryUnrestricted(): void;
  installApk(path: string): string;
}

export function android(): AndroidBridge | null {
  return (typeof window !== 'undefined' && (window as unknown as { AMAndroid?: AndroidBridge }).AMAndroid) || null;
}

export function startAndroid() {
  const b = android();
  if (!b) return;
  const root = document.documentElement;
  const applyInsets = () => {
    try {
      const i = JSON.parse(b.insets()) as { top: number; bottom: number };
      root.style.setProperty('--safe-top', `${i.top}px`);
      root.style.setProperty('--safe-bottom', `${i.bottom}px`);
    } catch {
      /* keep the last ones */
    }
  };
  applyInsets();
  window.addEventListener('am-insets', applyInsets);
  const bars = () => b.setLightBars(!root.classList.contains('dark'));
  bars();
  new MutationObserver(bars).observe(root, { attributes: true, attributeFilter: ['class'] });
  let last: boolean | null = null;
  const keep = () => {
    const on = usePrefs.getState().androidKeepAlive && useApp.getState().servers.length > 0;
    if (on === last) return;
    b.keepAlive((last = on));
    // Android 13+ shows the service's notification only with this permission.
    if (on) {
      void import('@tauri-apps/plugin-notification')
        .then(async (n) => (await n.isPermissionGranted()) || (await n.requestPermission()))
        .catch(() => {});
    }
  };
  keep();
  usePrefs.subscribe(keep);
  useApp.subscribe(keep);
}
