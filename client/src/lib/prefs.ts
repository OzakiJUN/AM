// Small per-device UI preferences that are not part of a theme.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  set: (p: Partial<Pick<Prefs, 'listFolded' | 'membersFolded'>>) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      portrait: 'center',
      portraitOpen: 'center',
      setPortrait: (p) => set(p === 'corner' ? { portrait: p } : { portrait: p, portraitOpen: p }),
      listFolded: false,
      membersFolded: false,
      set: (p) => set(p),
    }),
    { name: 'am-prefs' },
  ),
);
