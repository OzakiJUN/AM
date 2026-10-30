// Online state and activities ("正在听歌") shown next to people. Pure helpers;
// the state itself lives in SessionView.presence (see session.ts).
import type { Activity, ActivityKind, Presence } from './types';

export interface ActivityInfo {
  kind: ActivityKind;
  /** "正在听歌" */
  label: string;
  /** Placeholder for the detail input. */
  hint: string;
  emoji: string;
}

export const ACTIVITIES: ActivityInfo[] = [
  { kind: 'listening', label: '正在听歌', hint: '歌名（可不填）', emoji: '🎧' },
  { kind: 'playing', label: '正在打游戏', hint: '游戏名（可不填）', emoji: '🎮' },
  { kind: 'tuning_ai', label: '正在调试 AI', hint: '在调哪个 AI（可不填）', emoji: '🛠️' },
  { kind: 'working', label: '学习 / 工作中', hint: '在忙什么（可不填）', emoji: '📚' },
  { kind: 'custom', label: '自定义', hint: '想说的状态（必填）', emoji: '💬' },
];

/** Longest activity detail the server accepts. */
export const ACTIVITY_MAX = 32;

/** One line for an activity: "🎧 正在听歌：晴天", "💬 摸鱼中". */
export function activityText(a?: Activity): string {
  if (!a) return '';
  const info = ACTIVITIES.find((x) => x.kind === a.kind);
  if (!info) return a.text;
  if (a.kind === 'custom') return `${info.emoji} ${a.text}`;
  return `${info.emoji} ${info.label}${a.text ? `：${a.text}` : ''}`;
}

/** Status line for a person: activity, "在线", "隐身中" or "离线". */
export function presenceText(p?: Presence): string {
  if (!p) return '离线';
  if (p.activity) return activityText(p.activity) + (p.invisible ? '（隐身中）' : '');
  return p.invisible ? '隐身中' : '在线';
}
