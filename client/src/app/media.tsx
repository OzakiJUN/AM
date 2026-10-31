import { useEffect, useState } from 'react';
import { activityEmoji } from '@/lib/presence';
import { session, usePresence } from '@/lib/store';
import type { Conversation, User } from '@/lib/types';
import { Avatar } from '@/ui';

/** Resolves a media path (/api/v1/media/…) of the current server to a URL for <img>. */
export function useMediaUrl(path?: string, serverId?: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!path) return;
    let alive = true;
    session(serverId)?.t.mediaUrl(path).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [path, serverId]);
  return url;
}

/**
 * Avatar of a user. In lists `animated` is off: a GIF shows its first frame.
 * `presence` adds the online dot in the top-right corner.
 */
export function UserAvatar({ user, size = 40, status, animated, presence }: {
  user?: User; size?: number; status?: boolean | 'invisible'; animated?: boolean; presence?: boolean;
}) {
  const src = useMediaUrl(animated ? user?.avatar : user?.avatarStatic);
  const p = usePresence(presence ? user?.id : undefined);
  if (presence) status = p ? (p.invisible ? 'invisible' : true) : false;
  return <Avatar src={src} name={user?.name ?? '?'} size={size} status={status} statusAt={presence ? 'top' : 'bottom'} emoji={presence ? activityEmoji(p) : undefined} />;
}

/** Channel avatar, or the peer's avatar (with the online dot) for a DM. */
export function ConvAvatar({ conv, peer, size = 46 }: { conv: Conversation; peer?: User; size?: number }) {
  const src = useMediaUrl(conv.kind === 'group' ? conv.avatar : peer?.avatarStatic);
  const p = usePresence(conv.kind === 'dm' ? peer?.id : undefined);
  const status = conv.kind === 'dm' && peer ? (p ? (p.invisible ? 'invisible' : true) : false) : undefined;
  return <Avatar src={src} name={conv.kind === 'group' ? conv.name : peer?.name ?? conv.name} size={size} square={conv.kind === 'group'} status={status} statusAt="top" emoji={conv.kind === 'dm' ? activityEmoji(p) : undefined} />;
}

/** Server icon (set in the admin panel), or the first letter on a gradient. */
export function ServerAvatar({ name, icon, serverId, size = 38 }: { name: string; icon?: string; serverId?: string; size?: number }) {
  const src = useMediaUrl(icon || undefined, serverId);
  return <Avatar src={src} name={name} size={size} square />;
}

export const mediaPath = (id: string, thumb = false) => `/api/v1/media/${id}${thumb ? '/thumb' : ''}`;
