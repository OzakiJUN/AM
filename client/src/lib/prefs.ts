// Small per-device UI preferences that are not part of a theme.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { inTauri } from './platform';

/** Where the AI portrait sits in an AI chat; 'corner' = folded into the top-right corner. */
export type PortraitPos = 'left' | 'center' | 'right' | 'corner';

interface Prefs {
  portrait: PortraitPos;
  /** Last open position, restored when the folded portrait is clicked. */
  portraitOpen: Exclude<PortraitPos, 'corner'>;
  setPortrait: (p: PortraitPos) => void;
  /** Conversation list (left) folded into a column of avatars. */
  listFolded: boolean;
  /** Channel member list (right) folded into a column of avatars. */
  membersFolded: boolean;
  /** Copy changes of my profile to my other servers (lib/sync.ts). */
  profileSync: boolean;
  /** Seconds to wait after the last change before syncing. */
  syncDelay: number;
  /** Copy my stickers to my other servers in the background (lib/stickerSync.ts). */
  stickerSync: boolean;
  /** Music widget playback volume on this device (0–100). */
  musicVolume: number;
  /** Desktop: the close button hides the window to the tray (AIs run by this device stay online) instead of quitting. */
  closeToTray: boolean;
  set: (p: Partial<Pick<Prefs, 'listFolded' | 'membersFolded' | 'profileSync' | 'syncDelay' | 'stickerSync' | 'musicVolume' | 'closeToTray'>>) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      portrait: 'center',
      portraitOpen: 'center',
      setPortrait: (p) => set(p === 'corner' ? { portrait: p } : { portrait: p, portraitOpen: p }),
      listFolded: false,
      membersFolded: false,
      profileSync: true,
      syncDelay: 30,
      stickerSync: true,
      musicVolume: 30,
      closeToTray: true,
      set: (p) => set(p),
    }),
    { name: 'am-prefs' },
  ),
);

/** Tells the desktop app what the close button does, now and on every change. */
export function watchClosePref() {
  if (!inTauri) return;
  const send = (on: boolean) => void import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_close_to_tray', { on })).catch(() => {});
  let last = usePrefs.getState().closeToTray;
  send(last);
  usePrefs.subscribe((p) => {
    if (p.closeToTray !== last) send((last = p.closeToTray));
  });
}
