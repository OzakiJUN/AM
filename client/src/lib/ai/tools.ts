// Runs one tool call for an AI that operates this computer (docs/design.md
// §9). The desktop app does the work in Rust (src-tauri/src/agent.rs); in
// browser development mode only the clipboard works.
import { copyText, inTauri, readClipboardText } from '../platform';
import { mcpTool, mcpToolName, type ToolDef } from './agent';
import type { ComputerSettings, McpServer } from './persona';

export interface ToolResult {
  text: string;
  /** Screenshots (base64 PNG) for the model to look at. */
  images?: string[];
}

export interface ToolCtx {
  computer: ComputerSettings;
  /** Screen pixels per screenshot pixel, from the last screenshot. */
  scale: number;
  /** Model-facing MCP tool name -> its server and real name (loadMcpTools). */
  mcp: Map<string, { server: McpServer; tool: string }>;
  /** Keeps MCP servers apart per AI (`${serverId}|${aiId}`). */
  owner: string;
}

interface UINode { id: number; depth: number; role: string; name: string; value: string; enabled: boolean }

/** A window's controls as an indented, numbered list for the model. */
export function formatTree(nodes: UINode[]): string {
  if (!nodes.length) return '（读不到控件：这个程序可能不支持界面自动化，可以试试截图）';
  return nodes
    .map((x) => {
      const val = x.value && x.value !== x.name ? ` = ${x.value.slice(0, 80)}` : '';
      return `${'  '.repeat(Math.min(x.depth, 12))}[${x.id}] ${x.role} ${x.name.slice(0, 80)}${val}${x.enabled ? '' : '（不可用）'}`;
    })
    .join('\n');
}

/** Stops an AI's MCP servers (it no longer runs on this device). */
export function stopMcp(owner: string) {
  if (inTauri) void rust('mcp_stop', { prefix: `${owner}|` }).catch(() => {});
}

const spec = (m: McpServer) => [m.command.trim(), ...m.args];

type McpToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };

/** One MCP server's tools (starting it under `key` when needed). */
export function listMcpTools(m: McpServer, key: string): Promise<McpToolInfo[]> {
  return rust<McpToolInfo[]>('mcp_tools', { key, spec: spec(m) });
}

/**
 * The tools of an AI's MCP servers (starts them when needed). A server that
 * fails is reported in `errors` so the AI can tell people, not hidden.
 */
export async function loadMcpTools(c: ComputerSettings, owner: string): Promise<{ defs: ToolDef[]; map: ToolCtx['mcp']; errors: string[] }> {
  const defs: ToolDef[] = [];
  const map: ToolCtx['mcp'] = new Map();
  const errors: string[] = [];
  if (!c.enabled || c.levels.mcp === 'deny' || !inTauri) return { defs, map, errors };
  for (const m of c.mcp) {
    if (!m.enabled || !m.command.trim()) continue;
    try {
      const list = await listMcpTools(m, `${owner}|${m.name}`);
      for (const t of list) {
        const name = mcpToolName(m.name, t.name);
        if (map.has(name)) continue;
        map.set(name, { server: m, tool: t.name });
        defs.push(mcpTool(m.name, t));
      }
    } catch (e) {
      errors.push(`${m.name}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { defs, map, errors };
}

async function rust<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error('这个操作只在桌面版可用');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

const MAX_READ = 30_000;
const SHOT_WIDTH = 1280;

const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export async function execTool(name: string, a: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const roots = ctx.computer.workDirs;
  switch (name) {
    case 'list_dir': {
      const list = await rust<{ name: string; dir: boolean; size: number }[]>('agent_list_dir', { path: s(a.path), roots });
      return { text: list.length ? list.map((e) => (e.dir ? `[文件夹] ${e.name}` : `${e.name}（${e.size} 字节）`)).join('\n') : '（空文件夹）' };
    }
    case 'read_file':
      return { text: await rust<string>('agent_read_file', { path: s(a.path), roots, max: MAX_READ }) };
    case 'write_file':
      await rust('agent_write_file', { path: s(a.path), roots, content: s(a.content), append: a.append === true });
      return { text: '写好了' };
    case 'delete':
      await rust('agent_trash', { path: s(a.path), roots });
      return { text: '已移到回收站' };
    case 'run_command': {
      const o = await rust<{ code: number | null; stdout: string; stderr: string; timed_out: boolean }>('agent_run', {
        command: s(a.command), cwd: roots[0] ?? null, timeout: Math.min(600, Math.max(1, n(a.timeout_seconds, 60))),
      });
      if (o.timed_out) return { text: '超时了，命令被停掉' };
      return { text: [`退出码 ${o.code ?? '?'}`, o.stdout && `输出：\n${o.stdout}`, o.stderr && `错误输出：\n${o.stderr}`].filter(Boolean).join('\n') };
    }
    case 'open':
      await rust('agent_open', { target: s(a.target) });
      return { text: '已打开' };
    case 'get_clipboard':
      return { text: (await readClipboardText()) ?? '（读不到剪贴板）' };
    case 'set_clipboard':
      await copyText(s(a.text));
      return { text: '已放进剪贴板' };
    case 'screenshot': {
      const shot = await rust<{ png: string; width: number; height: number; screen_width: number; screen_height: number }>('agent_screenshot', { maxWidth: SHOT_WIDTH });
      ctx.scale = shot.screen_width / shot.width;
      return { text: `截图 ${shot.width}×${shot.height}（屏幕 ${shot.screen_width}×${shot.screen_height}），鼠标坐标按这张截图的像素给`, images: [shot.png] };
    }
    case 'mouse': {
      const act = s(a.action);
      const action =
        act === 'scroll' ? { action: 'scroll', amount: Math.round(n(a.amount, 3)) }
          : act === 'move' ? { action: 'move', x: Math.round(n(a.x, 0)), y: Math.round(n(a.y, 0)) }
            : { action: 'click', x: Math.round(n(a.x, 0)), y: Math.round(n(a.y, 0)), button: act === 'right_click' ? 'right' : 'left', double: act === 'double_click' };
      await rust('agent_input', { action, scale: ctx.scale, quietMs: ctx.computer.yieldSeconds * 1000 });
      return { text: '好了' };
    }
    case 'keyboard': {
      const action = a.keys ? { action: 'keys', keys: s(a.keys) } : { action: 'type', text: s(a.text) };
      await rust('agent_input', { action, scale: ctx.scale, quietMs: ctx.computer.yieldSeconds * 1000 });
      return { text: '好了' };
    }
    case 'ui_windows': {
      const list = await rust<{ handle: number; title: string; class: string; pid: number }[]>('agent_ui_windows', {});
      return { text: list.length ? list.map((w) => `窗口 ${w.handle}：${w.title}`).join('\n') : '（没有打开的窗口）' };
    }
    case 'ui_read':
      return { text: formatTree(await rust<UINode[]>('agent_ui_tree', { handle: n(a.window, 0) })) };
    case 'ui_act':
      return {
        text: await rust<string>('agent_ui_act', { handle: n(a.window, 0), id: n(a.id, 0), expect: s(a.name), action: s(a.action), text: a.text == null ? null : s(a.text) }),
      };
    case 'ui_focus_window':
      await rust('agent_ui_activate', { handle: n(a.window, 0) });
      return { text: '切过去了' };
    case 'browser_open':
      return { text: await rust<string>('agent_browser', { action: 'open', url: s(a.url) }) };
    case 'browser_read':
      return { text: await rust<string>('agent_browser', { action: 'read' }) };
    case 'browser_click':
      return { text: await rust<string>('agent_browser', { action: 'click', n: n(a.n, 0) }) };
    case 'browser_type':
      return { text: await rust<string>('agent_browser', { action: 'type', n: n(a.n, 0), text: s(a.text), submit: a.submit === true }) };
    case 'browser_scroll':
      return { text: await rust<string>('agent_browser', { action: 'scroll', pages: n(a.pages, 1) }) };
    case 'browser_back':
      return { text: await rust<string>('agent_browser', { action: 'back' }) };
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, n(a.seconds, 1))) * 1000));
      return { text: '等好了' };
    default: {
      const m = ctx.mcp.get(name);
      if (!m) return { text: `没有这个工具：${name}` };
      const r = await rust<{ text: string; images: string[]; error: boolean }>('mcp_call', {
        key: `${ctx.owner}|${m.server.name}`, spec: spec(m.server), tool: m.tool, args: a, timeout: 120,
      });
      const text = (r.error ? '工具报错：' : '') + (r.text || (r.images.length ? '（结果是图片）' : '（没有返回内容）'));
      return { text: text.slice(0, MAX_READ), images: r.images.length ? r.images : undefined };
    }
  }
}
