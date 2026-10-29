// Platform helpers: clipboard, QR from image, desktop notifications. Inside
// the desktop app they use Tauri plugins; in a plain browser (development)
// the web APIs.
import jsQR from 'jsqr';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Reads the clipboard text, or null if it cannot be read. */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (inTauri) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return await readText();
    }
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

export async function copyText(text: string) {
  try {
    if (inTauri) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  } catch {
    /* ignore */
  }
}

/** Finds a QR code in an image file and returns its text. */
export async function scanQRFromFile(file: Blob): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(img.data, img.width, img.height)?.data ?? null;
}

let notifyAllowed: boolean | null = null;

/** Shows a desktop notification (asks for permission the first time). */
export async function notify(title: string, body: string) {
  if (localStorage.getItem('am-notify') === 'off') return;
  try {
    if (inTauri) {
      const n = await import('@tauri-apps/plugin-notification');
      if (notifyAllowed === null) {
        notifyAllowed = (await n.isPermissionGranted()) || (await n.requestPermission()) === 'granted';
      }
      if (notifyAllowed) n.sendNotification({ title, body });
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') await Notification.requestPermission();
    if (Notification.permission === 'granted') new Notification(title, { body });
  } catch {
    /* notifications unavailable */
  }
}

export async function openUrl(url: string) {
  if (inTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}
