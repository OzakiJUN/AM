import type { Message } from './types.ts';

/** A single-level quotation. Never expand nested replies or deleted content. */
export function replyPreview(message: Message | null | undefined): string {
  if (!message) return '原消息暂不可用';
  if (message.body.kind === 'deleted') return '原消息已被删除';
  if (message.struck) return '原消息已划掉';
  switch (message.body.kind) {
    case 'text': return message.body.text;
    case 'image': return message.body.stickerTags?.length ? `[表情：${message.body.stickerTags.join('、')}]` : '[图片]';
    case 'file': return `[文件：${message.body.name}]`;
    default: return '原消息暂不可用';
  }
}

export function replyTarget(message: Message, messages: Message[], targets: Record<string, Message | null> = {}): Message | null | undefined {
  if (message.body.kind !== 'text' || !message.body.replyTo) return undefined;
  const id = message.body.replyTo;
  return messages.find((m) => m.id === id) ?? targets[message.body.replyTo];
}

export function replyContext(message: Message, target: Message | null | undefined, name: (id: string) => string): string {
  if (message.body.kind !== 'text' || !message.body.replyTo) return '';
  const author = target?.senderId ? name(target.senderId) : '未知用户';
  return `（回复 ${author} 的消息 ${message.body.replyTo}，引用原文：${JSON.stringify(replyPreview(target).slice(0, 600))}）\n`;
}
