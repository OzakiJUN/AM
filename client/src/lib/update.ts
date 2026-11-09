// Client updates (docs/release.md, docs/design.md §3 更新). The desktop app
// checks GitHub's latest release a while after start and every 6 hours
// (prefs updateCheck), and hears from servers that updated (ServerInfo.
// client_version, ClientUpdatePush): it reads that server's copy of
// release.json. Either way the manifest is verified with the built-in key
// (lib/release.ts) before anything is offered. Installing downloads the
// new version — the installer for an installed AM, AM.exe for the portable
// one (GitHub, mirrors, then a server that keeps the installer; Rust checks
// the size + SHA-256) — puts it in place and quits; AM starts again.
// Browser dev mode and host mode don't update.

import { create } from 'zustand';
import { inTauri, isAndroid, openUrl } from './platform';
import { usePrefs } from './prefs';
import { session, useApp } from './store';
import { apkOf, compareVersions, isRelease, loadManifest, MANIFEST, type Manifest, RELEASE_PUBLIC_KEY, releaseUrls, SIGNATURE, updateFileOf } from './release';

export const APP_VERSION = __APP_VERSION__;

type Status = 'idle' | 'checking' | 'downloading' | 'installing' | 'error';

interface UpdateState {
  /** Newest verified release seen (newer or not). */
  latest: Manifest | null;
  status: Status;
  error: string;
  checkedAt: number;
  done: number;
  total: number;
  /** Servers keeping the latest version's installer (fallback download). */
  servers: string[];
}

export const useUpdate = create<UpdateState>(() => ({ latest: null, status: 'idle', error: '', checkedAt: 0, done: 0, total: 0, servers: [] }));

/** Why this build can't update ('' = it can). */
export function cannotUpdate(): string {
  if (!inTauri) return '浏览器开发模式不更新';
  if (!RELEASE_PUBLIC_KEY) return '这个版本没有内置发布公钥，不能自动更新';
  if (!isRelease(APP_VERSION)) return `开发版（${APP_VERSION}）不自动更新，去 GitHub 下载正式版`;
  return '';
}

/** A newer verified release is known. */
export const updateAvailable = (s: UpdateState) => !!s.latest && compareVersions(s.latest.version, APP_VERSION) > 0;

async function getBytes(url: string, max: number): Promise<Uint8Array> {
  const { invoke } = await import('@tauri-apps/api/core');
  return new Uint8Array(await invoke<ArrayBuffer>('web_get_bytes', { url, max }));
}

/** Takes a manifest if it verifies and is at least as new as the one known. */
async function adopt(data: Uint8Array, sig: string, server?: string): Promise<boolean> {
  const m = await loadManifest(data, sig);
  if (!m) return false;
  const cur = useUpdate.getState().latest;
  const c = cur ? compareVersions(m.version, cur.version) : 1;
  if (c < 0) return true;
  const servers = c > 0 ? [] : useUpdate.getState().servers;
  useUpdate.setState({ latest: m, servers: server && !servers.includes(server) ? [...servers, server] : servers });
  announce();
  return true;
}

let announced = '';

/** Says once per version that there is one (the 设置 badge stays). */
function announce() {
  const s = useUpdate.getState();
  if (!updateAvailable(s) || announced === s.latest!.version) return;
  announced = s.latest!.version;
  void import('../ui').then(({ toast }) => toast(`AM 有新版本 ${s.latest!.version}：设置 → 关于与更新`));
}

/** Reads GitHub's latest release.json (then the mirrors'). */
export async function checkGitHub(): Promise<void> {
  const busy = useUpdate.getState().status;
  if (cannotUpdate() || (busy !== 'idle' && busy !== 'error')) return;
  useUpdate.setState({ status: 'checking', error: '' });
  const urls = releaseUrls(MANIFEST);
  const sigs = releaseUrls(SIGNATURE);
  const errs: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const [data, sig] = await Promise.all([getBytes(urls[i], 1 << 20), getBytes(sigs[i], 4096)]);
      if (!(await adopt(data, new TextDecoder().decode(sig)))) throw new Error('签名不对');
      useUpdate.setState({ status: 'idle', checkedAt: Date.now() });
      return;
    } catch (e) {
      errs.push(new URL(urls[i]).host + '：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  useUpdate.setState({ status: 'error', error: '检查更新失败：' + errs.join('；'), checkedAt: Date.now() });
}

/** A server says it keeps a newer client: read and verify its copy of the manifest. */
export async function offerFromServer(serverId: string, version: string): Promise<void> {
  if (cannotUpdate() || !version || compareVersions(version, APP_VERSION) <= 0) return;
  const s = session(serverId);
  if (!s) return;
  try {
    const [data, sig] = await Promise.all([s.updateFile(MANIFEST), s.updateFile(SIGNATURE)]);
    await adopt(data, new TextDecoder().decode(sig), serverId);
  } catch {
    // GitHub still works
  }
}

/** Downloads the installer, checks it, runs it and quits. */
export async function installUpdate(): Promise<void> {
  const st = useUpdate.getState();
  const m = st.latest;
  const why = cannotUpdate();
  if (why) throw new Error(why);
  if (!m || !updateAvailable(st)) throw new Error('已经是最新版了');
  // Android: the system installs APKs; open the verified release's APK in
  // the browser, which downloads it and hands it to the installer (the
  // phone only accepts it when it is signed with the same key).
  if (isAndroid) {
    const apk = apkOf(m);
    if (!apk) throw new Error(`${m.version} 没有安卓版`);
    await openUrl(releaseUrls(apk.name, 'v' + m.version)[0]);
    return;
  }
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  // An installed AM runs the installer; the portable AM.exe swaps itself (update.rs).
  const portable = (await invoke<string>('update_mode')) === 'portable';
  const f = updateFileOf(m, portable);
  if (!f) throw new Error(`${m.version} 没有 Windows 的${portable ? '免安装版' : '安装包'}`);
  // GitHub, the mirrors, then every server that keeps this version (installer only).
  const holders = new Set(st.servers);
  for (const r of useApp.getState().servers) if (useApp.getState().sessions[r.id]?.clientVersion === m.version) holders.add(r.id);
  const sources = [...releaseUrls(f.name, 'v' + m.version).map((url) => ({ url })), ...(portable ? [] : [...holders].map((server) => ({ server })))];
  useUpdate.setState({ status: 'downloading', error: '', done: 0, total: f.size });
  try {
    const on = new Channel<number>();
    on.onmessage = (done) => useUpdate.setState({ done });
    const path = await invoke<string>('update_download', { sources, version: m.version, portable, size: f.size, sha256: f.sha256, onProgress: on });
    useUpdate.setState({ status: 'installing' });
    await invoke('update_install', { path });
  } catch (e) {
    useUpdate.setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/** Checks after start and every 6 hours while prefs.updateCheck is on. */
export function startUpdates() {
  if (cannotUpdate()) return;
  const tick = () => {
    if (usePrefs.getState().updateCheck) void checkGitHub();
  };
  setTimeout(tick, 20_000);
  setInterval(tick, 6 * 3600_000);
}
