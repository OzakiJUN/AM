// Whether the AI's browser goes through a proxy (docs/design.md §9 上网冲浪).
// A per-device choice (the browser is shared by every AI this device runs):
// follow the system, never, always, or let the AI decide per page. Pure;
// tested in proxy.test.ts. The browser is restarted when the choice changes
// (Rust browser.rs).

export type ProxyMode = 'system' | 'off' | 'on' | 'auto';

export interface ProxyPref {
  mode: ProxyMode;
  /** host:port, or http:// https:// socks4:// socks5:// + host:port. */
  server: string;
}

export const DEFAULT_PROXY: ProxyPref = { mode: 'system', server: '' };

export const PROXY_MODE_LABEL: Record<ProxyMode, string> = {
  system: '跟系统',
  off: '不走代理',
  on: '全走代理',
  auto: '让它自己决定',
};

/** The proxy address as the browser wants it, or null when it is not one. */
export function proxyServer(s: string): string | null {
  const t = s.trim();
  const m = /^(?:(https?|socks[45]):\/\/)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):(\d{1,5})\/?$/.exec(t);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535) return null;
  return `${m[1] ?? 'http'}://${m[2]}:${m[3]}`;
}

/** Sites usually out of reach without a proxy in mainland China. */
const FAR = [
  'youtube.com', 'youtu.be', 'googlevideo.com', 'google.com', 'google.com.hk', 'twitter.com', 'x.com', 'facebook.com',
  'instagram.com', 'reddit.com', 'wikipedia.org', 'pixiv.net', 'discord.com', 'twitch.tv', 'nicovideo.jp',
  'telegram.org', 't.me', 'medium.com', 'tiktok.com', 'threads.net', 'archive.org', 'steamcommunity.com',
];

/** A best guess whether this address needs the proxy. */
export function needsProxy(url: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FAR.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * What to tell the browser for one call: 'system', 'direct', a proxy
 * address, or null = whatever it runs with now (no restart). `url` is set
 * for calls that open a page; `ask` is the AI's own choice (auto mode).
 */
export function proxyFor(pref: ProxyPref, url?: string, ask?: boolean): string | null {
  const server = proxyServer(pref.server);
  switch (pref.mode) {
    case 'off': return 'direct';
    case 'on': return server ?? 'system';
    case 'auto':
      if (!server) return 'system';
      if (url === undefined) return null;
      return (ask ?? needsProxy(url)) ? server : 'direct';
    default: return 'system';
  }
}

/** Auto mode with a usable address: the AI gets to choose per page. */
export function canChooseProxy(pref: ProxyPref | undefined): boolean {
  return pref?.mode === 'auto' && proxyServer(pref.server) !== null;
}

/** A page that did not open directly and may open through the proxy. */
export function looksBlocked(error: string): boolean {
  return /ERR_(CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED)|TIMED_OUT|NAME_NOT_RESOLVED|SSL_PROTOCOL_ERROR|EMPTY_RESPONSE|ADDRESS_UNREACHABLE)|没反应/.test(error);
}
