// AI plugins on the client (docs/plugins.md): the settings form generated
// from what the server read out of a plugin, and telling plugin commands
// apart from chat so the AI's own runner leaves them to the plugins. Pure,
// unit-tested (plugins.test.ts).

/** The parts of a plugin setting the form needs (lib/session.ts PluginSetting). */
export interface SettingLike {
  key: string;
  label: string;
  group: string;
  /** string | int | float | bool | list | path | select | text */
  type: string;
  default: unknown;
  options: string[];
  secret: boolean;
  min?: number;
  max?: number;
}

/** Settings in their groups, in the order they came ('' = no group). */
export function groupSettings<T extends SettingLike>(settings: T[]): { group: string; items: T[] }[] {
  const out: { group: string; items: T[] }[] = [];
  for (const s of settings) {
    let g = out.find((x) => x.group === s.group);
    if (!g) out.push((g = { group: s.group, items: [] }));
    g.items.push(s);
  }
  return out;
}

/** A readable label: the author's, or the key without the plugin's prefix ("qqdraw_steps" -> "steps"). */
export function settingLabel(s: SettingLike, dir: string): string {
  if (s.label) return s.label;
  const pre = dir.toLowerCase() + '_';
  return s.key.toLowerCase().startsWith(pre) ? s.key.slice(pre.length) : s.key;
}

/** A list whose items are all numbers is edited as numbers. */
const numericList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number');

/** What a text box shows for a value. */
export function toText(s: SettingLike, v: unknown): string {
  if (v === undefined || v === null) return '';
  if (s.type === 'list') {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join('\n');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Reads what was typed for a setting: the value to save, or why it can't be. '' = back to the default (null). */
export function fromText(s: SettingLike, text: string, current?: unknown): { value: unknown } | { error: string } {
  const t = s.type === 'text' ? text : text.trim();
  if (t === '') return { value: null };
  switch (s.type) {
    case 'int':
    case 'float': {
      const n = Number(t);
      if (!Number.isFinite(n)) return { error: '要填数字' };
      if (s.type === 'int' && !Number.isInteger(n)) return { error: '要填整数' };
      if (s.min !== undefined && n < s.min) return { error: `不能小于 ${s.min}` };
      if (s.max !== undefined && n > s.max) return { error: `不能大于 ${s.max}` };
      return { value: n };
    }
    case 'list': {
      if (t.startsWith('[')) {
        try {
          const v = JSON.parse(t);
          if (Array.isArray(v)) return { value: v };
        } catch {
          /* one per line */
        }
      }
      const items = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (numericList(current ?? s.default)) {
        const nums = items.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) return { error: '每行一个数字' };
        return { value: nums };
      }
      return { value: items };
    }
    case 'select':
      if (s.options.length && !s.options.includes(t)) return { error: '不在可选项里' };
      return { value: t };
    default:
      return { value: t };
  }
}

/**
 * Is this message a plugin command (so the AI shouldn't answer it too)?
 * Like NoneBot: a command prefix, then the command; whatever follows is its
 * argument. @-mentions at the start are skipped (NoneBot drops the @ of the bot).
 */
export function isPluginCommand(text: string, starts: string[], commands: string[]): boolean {
  const t = text.replace(/^(\s*@\S+)+\s*/, '').trimStart();
  if (!t || !commands.length) return false;
  for (const st of starts.length ? starts : ['/']) {
    if (!t.startsWith(st)) continue;
    const rest = t.slice(st.length);
    if (commands.some((c) => c && rest.startsWith(c))) return true;
  }
  return false;
}
