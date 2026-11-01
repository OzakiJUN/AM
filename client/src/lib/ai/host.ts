// Host mode (docs/design.md §10 托管): am-server started this client with
// `--host <file>` to run one AI without a window. No UI, no owner, no other
// servers: just that AI, with the owner's model keys from the file and its
// own work folder. Settings / rules: lib/ai/hostMode.ts (pure, tested).
import { inTauri } from '../platform';
import { useProviders } from './keys';
import { parseHostConfig, type HostConfig } from './hostMode';
import { startHosted } from './runner';

/** The device id hosted AIs run on (settings.runner.id, server/internal/hosting RunnerID). */
export const HOST_DEVICE_ID = 'server-host';

/**
 * The host file, if this client was started in host mode. Desktop: from
 * Rust (`--host`). Browser development / e2e only: `#host=<base64 JSON>`.
 */
export async function readHostConfig(): Promise<HostConfig | null> {
  if (inTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return parseHostConfig(await invoke<string | null>('host_config').catch(() => null));
  }
  const m = /[#&]host=([A-Za-z0-9+/=_-]+)/.exec(location.hash);
  if (!m) return null;
  try {
    const b = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
    return parseHostConfig(new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

/** Runs the hosted AI (call instead of the normal start-up). */
export async function runHost(cfg: HostConfig) {
  try {
    // This client's browser data is its own (a separate data folder), so this never touches a normal client.
    localStorage.setItem('am-device-id', HOST_DEVICE_ID);
  } catch {
    /* storage blocked: deviceId() then can't match; nothing would run */
  }
  useProviders.setState({ at: Date.now(), list: cfg.providers, loaded: true });
  document.title = 'AM（服务器托管）';
  await startHosted(cfg, () => {
    console.error('host: logged out, quitting');
    if (inTauri) void import('@tauri-apps/api/core').then(({ invoke }) => invoke('host_exit')).catch(() => {});
  });
}
