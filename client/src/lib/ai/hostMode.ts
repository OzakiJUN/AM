// Host mode (docs/design.md §10 托管): am-server runs this client without a
// window for one AI (`AM.exe --host <file>`). What it gets and what the AI
// may do there. Pure, unit-tested (hostMode.test.ts); lib/ai/host.ts runs it.
import type { AISettings, Level, ToolCategory } from './persona';
import type { Provider } from './providers';

/** The host file am-server writes (server/internal/hosting HostFile). */
export interface HostConfig {
  server: { address: string; plain: boolean; pin?: string };
  aiId: string;
  token: string;
  providers: Provider[];
  /** Its own folder for file tools. */
  workDir: string;
  /** The server lets it use a browser of its own (hosting.allow_browser; Rust keeps it headless in its own folder). */
  browser: boolean;
}

/** Reads the host file's JSON (null when it isn't one we understand). */
export function parseHostConfig(text: string | null | undefined): HostConfig | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<HostConfig> & { version?: number };
    if (v.version !== 1 || !v.server?.address || !v.aiId || !v.token || !v.workDir) return null;
    const providers = Array.isArray(v.providers) ? v.providers.filter((p) => p && typeof p.id === 'string') : [];
    return { server: { address: v.server.address, plain: !!v.server.plain, pin: v.server.pin || undefined }, aiId: String(v.aiId), token: v.token, providers, workDir: v.workDir, browser: v.browser === true };
  } catch {
    return null;
  }
}

/** What the server's computer must never do for someone's AI: screen, mouse, keyboard, programs. */
const NEVER: ToolCategory[] = ['command', 'open', 'clipboard', 'screen', 'input', 'ui', 'mcp'];
/** Its own folder: files freely. */
const FILES: ToolCategory[] = ['files_read', 'files_write', 'files_delete'];

/**
 * The settings it runs with on the server: file tools only in its own work
 * folder, nothing that touches the computer itself; its own browser only
 * when the server allows it (and its owner does); nobody is there to
 * answer an "ask", so asking means no. Never saved back.
 */
export function hostedSettings(s: AISettings, workDir: string, browser = false): AISettings {
  const levels = { ...s.computer.levels } as Record<ToolCategory, Level>;
  for (const c of Object.keys(levels) as ToolCategory[]) if (levels[c] === 'ask') levels[c] = 'deny';
  for (const c of NEVER) levels[c] = 'deny';
  if (!browser) levels.browser = 'deny';
  for (const c of FILES) levels[c] = 'allow';
  return { ...s, computer: { ...s.computer, enabled: true, workDirs: [workDir], levels, mcp: [] } };
}
