import { useEffect, useState } from 'react';
import { session } from '@/lib/store';
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

/** Avatar of a user. In lists `animated` is off: a GIF shows its first frame. */
export function UserAvatar({ user, size = 40, status, animated }: { user?: User; size?: number; status?: boolean; animated?: boolean }) {
  const src = useMediaUrl(animated ? user?.avatar : user?.avatarStatic);
  return <Avatar src={src} name={user?.name ?? '?'} size={size} status={status} />;
}

export function ConvAvatar({ conv, peer, size = 46 }: { conv: Conversation; peer?: User; size?: number }) {
  const src = useMediaUrl(conv.kind === 'group' ? conv.avatar : peer?.avatarStatic);
  return <Avatar src={src} name={conv.kind === 'group' ? conv.name : peer?.name ?? conv.name} size={size} square={conv.kind === 'group'} />;
}

export function ServerAvatar({ name, size = 38 }: { name: string; size?: number }) {
  return <Avatar name={name} size={size} square />;
}

export const mediaPath = (id: string, thumb = false) => `/api/v1/media/${id}${thumb ? '/thumb' : ''}`;
