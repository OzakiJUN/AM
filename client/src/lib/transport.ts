// How the UI reaches one server. In the desktop app every request goes
// through the Rust side (certificate pinning, see src-tauri/src/net.rs). In a
// plain browser (development) the Vite dev server proxies /api and /ws to a
// local am-server, so plain fetch / WebSocket work.
import type { Join } from './joincode';
import { inTauri } from './platform';

export interface Reply {
  status: number;
  body: string;
}

export interface Socket {
  send(data: Uint8Array): void;
  close(): void;
}

export interface Endpoint {
  address: string;
  plain: boolean;
  /** Certificate pin as hex (stored form). */
  pin?: string;
}

export function endpointFromJoin(j: Join): Endpoint {
  return { address: j.address, plain: j.plain, pin: j.pin ? toHex(j.pin) : undefined };
}

export function toHex(b: Uint8Array) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
function fromHex(h: string) {
  return Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16));
}
function wireEndpoint(ep: Endpoint) {
  return { address: ep.address, plain: ep.plain, pin: ep.pin ? fromHex(ep.pin) : null };
}

export interface Transport {
  setToken(token: string | null): Promise<void>;
  api(method: string, path: string, body?: string): Promise<Reply>;
  upload(file: File): Promise<Reply>;
  openSocket(onFrame: (data: Uint8Array) => void, onClose: (reason: string) => void): Promise<Socket>;
  /** URL usable in <img src> for a media path (/api/v1/media/...). */
  mediaUrl(path: string): Promise<string>;
  /** Saves a media file to disk (asks where). */
  download(path: string, filename: string): Promise<boolean>;
}

/** Asks a not-yet-added server for its info (join screen). */
export async function fetchServerInfo(ep: Endpoint): Promise<Reply> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Reply>('server_info', { join: wireEndpoint(ep) });
  }
  const r = await fetch('/api/v1/server');
  return { status: r.status, body: await r.text() };
}

export function createTransport(id: string, ep: Endpoint): Transport {
  return inTauri ? new TauriTransport(id, ep) : new BrowserTransport();
}

function b64ToBytes(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

class TauriTransport implements Transport {
  private ready: Promise<void>;
  constructor(private id: string, ep: Endpoint) {
    this.ready = import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('register_server', { id, endpoint: wireEndpoint(ep), token: null }),
    );
  }
  private async invoke<T>(cmd: string, args?: Record<string, unknown>) {
    await this.ready;
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  setToken(token: string | null) {
    return this.invoke<void>('set_token', { id: this.id, token });
  }
  api(method: string, path: string, body?: string) {
    return this.invoke<Reply>('api', { id: this.id, method, path, body: body ?? null });
  }
  async upload(file: File) {
    await this.ready;
    const { invoke } = await import('@tauri-apps/api/core');
    const data = new Uint8Array(await file.arrayBuffer());
    return invoke<Reply>('upload', data, {
      headers: { 'x-server': encodeURIComponent(this.id), 'x-filename': encodeURIComponent(file.name || 'file') },
    });
  }
  async openSocket(onFrame: (d: Uint8Array) => void, onClose: (r: string) => void): Promise<Socket> {
    await this.ready;
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const ch = new Channel<{ type: 'frame'; data: string } | { type: 'closed'; reason: string }>();
    ch.onmessage = (ev) => (ev.type === 'frame' ? onFrame(b64ToBytes(ev.data)) : onClose(ev.reason));
    const handle = await invoke<number>('ws_open', { id: this.id, onEvent: ch });
    return {
      send: (d) => void invoke('ws_send', { handle, data: bytesToB64(d) }).catch(() => {}),
      close: () => void invoke('ws_close', { handle }),
    };
  }
  async mediaUrl(path: string) {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    return convertFileSrc(`${this.id}${path}`, 'ammedia');
  }
  async download(path: string, filename: string) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const dest = await save({ defaultPath: filename });
    if (!dest) return false;
    await this.invoke('download', { id: this.id, path, dest });
    return true;
  }
}

class BrowserTransport implements Transport {
  private token: string | null = null;
  private blobs = new Map<string, Promise<string>>();
  async setToken(token: string | null) {
    this.token = token;
  }
  private headers(extra?: Record<string, string>) {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra };
  }
  async api(method: string, path: string, body?: string) {
    const r = await fetch(path, { method, body, headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}) });
    return { status: r.status, body: await r.text() };
  }
  async upload(file: File) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const r = await fetch('/api/v1/media', { method: 'POST', body: fd, headers: this.headers() });
    return { status: r.status, body: await r.text() };
  }
  async openSocket(onFrame: (d: Uint8Array) => void, onClose: (r: string) => void): Promise<Socket> {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('连不上服务器'));
    });
    ws.onmessage = (e) => onFrame(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = (e) => onClose(e.reason || 'closed');
    return { send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d as Uint8Array<ArrayBuffer>), close: () => ws.close() };
  }
  mediaUrl(path: string) {
    let p = this.blobs.get(path);
    if (!p) {
      p = fetch(path, { headers: this.headers() }).then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return URL.createObjectURL(await r.blob());
      });
      this.blobs.set(path, p);
      p.catch(() => this.blobs.delete(path));
    }
    return p;
  }
  async download(path: string, filename: string) {
    const url = await this.mediaUrl(path);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    return true;
  }
}
