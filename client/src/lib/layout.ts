// Phone layout (docs/design.md §5 手机): below NARROW px the app shows one
// thing at a time (list, or chat, or a page) with a tab bar at the bottom,
// and big dialogs fill the screen. Same code on Android and in a narrow
// desktop window.
import { useSyncExternalStore } from 'react';

export const NARROW = 720;

const query = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(max-width: ${NARROW - 1}px)`) : null);

/** True on a phone-sized screen right now. */
export function isNarrow(): boolean {
  return query()?.matches ?? false;
}

function subscribe(cb: () => void) {
  const q = query();
  q?.addEventListener('change', cb);
  return () => q?.removeEventListener('change', cb);
}

/** Re-renders when the screen crosses the phone width. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}
