import { convPage, type ConvPage } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { Conversation } from '@/lib/types';

/** Unread messages in one conversation (0 for ones you left). */
export function convUnread(c: Conversation) {
  return c.left ? 0 : Math.max(0, c.lastSeq - c.readSeq);
}

/** Unread count of a server; `page` limits it to channels, DMs or AI chats. */
export function unread(v?: SessionView, page?: ConvPage) {
  if (!v) return 0;
  return Object.values(v.convs).reduce((n, c) => (page && convPage(c, v.users) !== page ? n : n + convUnread(c)), 0);
}
