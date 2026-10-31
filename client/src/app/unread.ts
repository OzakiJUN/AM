import { convPage, type ConvPage } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation } from '@/lib/types';

/** Do not disturb is on: no notifications, grey unread, not in the totals. */
export function isDnd(c: Conversation, now = Date.now()) {
  return c.dndUntil === -1 || c.dndUntil > now;
}

/** Unread messages in one conversation (0 for ones you left). */
export function convUnread(c: Conversation) {
  return c.left ? 0 : Math.max(0, c.lastSeq - c.readSeq);
}

/** Unread count of a server (do-not-disturb ones left out); `page` limits it to channels, DMs or AI chats. */
export function unread(v?: SessionView, page?: ConvPage) {
  if (!v) return 0;
  const now = Date.now();
  return Object.values(v.convs).reduce((n, c) => (isDnd(c, now) || (page && convPage(c, v.users) !== page) ? n : n + convUnread(c)), 0);
}

/** List order: pinned first (newest pin on top), left ones last, then the latest activity. */
export function byListOrder(a: Conversation, b: Conversation) {
  return Number(!!a.left) - Number(!!b.left) || b.pinnedOrder - a.pinnedOrder || b.lastTime - a.lastTime || b.lastSeq - a.lastSeq;
}
