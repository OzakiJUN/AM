// The Android back button (and the browser's back): closes whatever was
// opened last — a dialog, a chat, a page — instead of leaving the app.
// While anything is open there is exactly one extra history entry; back
// pops it, we close the newest open thing and put the entry back if more
// is open. When the last thing closes by itself (a ✕ button) the entry is
// removed again. History is touched only from sync(), after changes
// settle, so a quick open-close-open (React's dev double mount) never
// leaves stray entries. The stack is pure (BackStack, tested in
// back.test.ts); useBack wires it to React and window.history.
import { useEffect, useRef } from 'react';

export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  back(): void;
}

export class BackStack {
  private open: { id: number; close: () => void }[] = [];
  private next = 1;
  /** Our entry is in history. */
  private entry = false;
  /** We called back() to drop our entry; ignore that popstate. */
  private leaving = false;
  private queued = false;
  private readonly history: HistoryLike;
  private readonly schedule: (f: () => void) => void;

  constructor(history: HistoryLike, schedule: (f: () => void) => void = (f) => setTimeout(f, 0)) {
    this.history = history;
    this.schedule = schedule;
  }

  /** Something closable opened; returns what to call once it closed by itself. */
  push(close: () => void): () => void {
    const id = this.next++;
    this.open.push({ id, close });
    this.later();
    return () => {
      const i = this.open.findIndex((e) => e.id === id);
      if (i < 0) return; // closed by back already
      this.open.splice(i, 1);
      this.later();
    };
  }

  /** A history entry went away (popstate). */
  popped() {
    if (this.leaving) {
      this.leaving = false;
      this.later();
      return;
    }
    this.entry = false;
    this.open.pop()?.close();
    this.later();
  }

  private later() {
    if (this.queued) return;
    this.queued = true;
    this.schedule(() => {
      this.queued = false;
      this.sync();
    });
  }

  private sync() {
    if (this.leaving) return; // the back() we asked for is still on its way
    if (this.open.length && !this.entry) {
      this.history.pushState({ amBack: true }, '');
      this.entry = true;
    } else if (!this.open.length && this.entry) {
      this.entry = false;
      this.leaving = true;
      this.history.back();
    }
  }

  get size() {
    return this.open.length;
  }
}

let stack: BackStack | null = null;

function shared(): BackStack | null {
  if (typeof window === 'undefined' || !window.history) return null;
  if (!stack) {
    stack = new BackStack(window.history);
    window.addEventListener('popstate', () => stack?.popped());
  }
  return stack;
}

/** While `active`, the back button calls `close` (newest first). */
export function useBack(active: boolean, close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!active) return;
    return shared()?.push(() => ref.current());
  }, [active]);
}
