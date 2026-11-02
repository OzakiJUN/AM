import type { EmojiPin } from './types.ts';

/** Shared picker choices for image annotations and message decorations. */
export const CHAT_EMOJI = ['😀', '😂', '🥹', '😭', '😎', '🤔', '🥺', '😡', '😴', '👍', '👎', '👏', '🙏', '❤️', '🔥', '✨', '🎉', '💯', '👀', '🤝', '💀', '🐱', '🐧', '🌟'];

export type Point = { x: number; y: number };
export type ImageMark = { tool: 'pen' | 'mosaic' | 'emoji'; points: Point[]; color: string; size: number; emoji: string };

export function paintMarks(canvas: HTMLCanvasElement, original: CanvasImageSource, marks: ImageMark[]) {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(original, 0, 0);
  for (const mark of marks) {
    if (mark.tool === 'emoji') {
      const p = mark.points[0];
      ctx.font = `${mark.size * 4}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(mark.emoji, p.x, p.y);
    } else if (mark.tool === 'pen') {
      ctx.strokeStyle = mark.color; ctx.fillStyle = mark.color; ctx.lineWidth = mark.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      const first = mark.points[0];
      ctx.beginPath(); ctx.arc(first.x, first.y, mark.size / 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(first.x, first.y);
      for (const p of mark.points) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else {
      // Tile the canvas itself after each earlier mark so the mosaic also
      // covers existing annotations. Quantized cells remain stable while dragging.
      const cell = Math.max(8, Math.round(mark.size));
      for (const p of mark.points) {
        const left = Math.max(0, Math.floor((p.x - cell) / cell) * cell);
        const top = Math.max(0, Math.floor((p.y - cell) / cell) * cell);
        for (let y = top; y < Math.min(canvas.height, top + cell * 3); y += cell) {
          for (let x = left; x < Math.min(canvas.width, left + cell * 3); x += cell) {
            const w = Math.min(cell, canvas.width - x), h = Math.min(cell, canvas.height - y);
            const pixel = ctx.getImageData(Math.min(canvas.width - 1, x + Math.floor(w / 2)), Math.min(canvas.height - 1, y + Math.floor(h / 2)), 1, 1).data;
            ctx.clearRect(x, y, w, h);
            ctx.fillStyle = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3] / 255})`; ctx.fillRect(x, y, w, h);
          }
        }
      }
    }
  }
}

export const canvasPNG = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片导出失败')), 'image/png');
});

/** A delayed snapshot must not bring back a pin removed by a newer event. */
export function mergeEmojiPins(current: Record<string, EmojiPin>, incoming: EmojiPin[]): Record<string, EmojiPin> {
  const merged = { ...current };
  for (const pin of incoming) if (!merged[pin.id] || BigInt(pin.revision) > BigInt(merged[pin.id].revision)) merged[pin.id] = pin;
  return merged;
}
