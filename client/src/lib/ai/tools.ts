// Runs one tool call for an AI that operates this computer (docs/design.md
// §9). The desktop app does the work in Rust (src-tauri/src/agent.rs); in
// browser development mode only the clipboard works.
import { copyText, inTauri, readClipboardText } from '../platform';
import type { ComputerSettings } from './persona';

export interface ToolResult {
  text: string;
  /** Screenshots (base64 PNG) for the model to look at. */
  images?: string[];
}

export interface ToolCtx {
  computer: ComputerSettings;
  /** Screen pixels per screenshot pixel, from the last screenshot. */
  scale: number;
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
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, n(a.seconds, 1))) * 1000));
      return { text: '等好了' };
    default:
      return { text: `没有这个工具：${name}` };
  }
}
