// Uploaded bytes use the server's existing 24-hour unreferenced-media grace
// period. Only small references live in the AI's server-backed memory.
export const PICTURE_TTL = 24 * 3600_000;
export const MAX_PICTURES = 5;
export interface KeptPicture {
  mediaId: string;
  activity: string;
  at: number;
  source: string;
  text: string;
}

export function livePictures(pictures: unknown, now: number): KeptPicture[] {
  if (!Array.isArray(pictures)) return [];
  return pictures.filter((p): p is KeptPicture => !!p && typeof p === 'object'
    && typeof p.mediaId === 'string' && /^[1-9]\d*$/.test(p.mediaId)
    && typeof p.activity === 'string' && p.activity.startsWith('leisure:')
    && Number.isFinite(p.at) && p.at <= now && now - p.at < PICTURE_TTL
    && typeof p.source === 'string' && typeof p.text === 'string')
    .map((p) => ({ ...p, source: sourceLink(p.source), text: p.text.slice(0, 300) })).slice(-MAX_PICTURES);
}

export function sourceLink(raw: string): string {
  try {
    const u = new URL(raw);
    if (!['https:', 'http:'].includes(u.protocol)) return '';
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.toString().slice(0, 2000);
  } catch { return ''; }
}

export function pictureFile(p: { data: string; mime: string }, maxBytes: number): File {
  const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[p.mime];
  if (!ext) throw new Error('只支持 png / jpg / gif / webp 图片');
  if (p.data.length > Math.ceil(maxBytes / 3) * 4) throw new Error('图片超过服务器上传上限');
  const bytes = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
  if (!bytes.length || bytes.length > maxBytes) throw new Error('图片为空或超过服务器上传上限');
  return new File([bytes], `browser.${ext}`, { type: p.mime });
}

/** Posting a capture also reads a page, even without a prior browser tool. */
export function idlePostBlocked(idle: boolean, name: string, args: Record<string, unknown>, browsed: boolean): boolean {
  const posts = ['send_picture', 'message_owner', 'send_to_channel', 'draw_picture'].includes(name)
    || (name === 'use_helper' && args.show === true);
  return idle && posts && (browsed || name === 'send_picture');
}
