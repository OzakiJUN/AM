import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Copy, Download, SendHorizontal, Undo2 } from 'lucide-react';
import { session } from '@/lib/store';
import { inTauri } from '@/lib/platform';
import { canvasPNG, CHAT_EMOJI, paintMarks, type ImageMark, type Point } from '@/lib/chatTools';
import { Button, Dialog, Segmented, Slider, Spinner, toast, toastError } from '@/ui';

export function ImageEditor({ serverId, convId, mediaId, onClose }: { serverId: string; convId: string; mediaId: string; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<ImageMark | null>(null);
  const [image, setImage] = useState<ImageBitmap | null>(null);
  const [error, setError] = useState('');
  const [tool, setTool] = useState<ImageMark['tool']>('pen');
  const [color, setColor] = useState('#ff3b60');
  const [size, setSize] = useState(16);
  const [emoji, setEmoji] = useState('😂');
  const [marks, setMarks] = useState<ImageMark[]>([]);
  const [working, setWorking] = useState(false);
  useEffect(() => {
    let gone = false;
    let bitmap: ImageBitmap | undefined;
    void (async () => {
      const source = session(serverId);
      if (!source) throw new Error('服务器未连接');
      const blob = await source.t.mediaBytes(`/api/v1/media/${mediaId}`);
      bitmap = await createImageBitmap(blob);
      if (!gone) setImage(bitmap);
      else bitmap.close();
    })().catch((e) => !gone && setError(String(e)));
    return () => { gone = true; bitmap?.close(); };
  }, [mediaId, serverId]);
  useEffect(() => {
    if (image && canvas.current) paintMarks(canvas.current, image, marks);
  }, [image, marks]);
  const point = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(e.currentTarget.width - 1, (e.clientX - rect.left) * e.currentTarget.width / rect.width)), y: Math.max(0, Math.min(e.currentTarget.height - 1, (e.clientY - rect.top) * e.currentTarget.height / rect.height)) };
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (working || !image || e.button !== 0) return;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
    const mark: ImageMark = { tool, color, size, emoji, points: [point(e)] };
    setMarks((old) => [...old, mark]);
    stroke.current = tool === 'emoji' ? null : mark;
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!stroke.current) return;
    const old = stroke.current;
    const last = old.points.at(-1)!;
    const p = point(e);
    const distance = Math.hypot(p.x - last.x, p.y - last.y);
    const count = Math.max(1, Math.ceil(distance / Math.max(2, size / 2)));
    const points = Array.from({ length: count }, (_, i) => ({ x: last.x + (p.x - last.x) * (i + 1) / count, y: last.y + (p.y - last.y) * (i + 1) / count }));
    const updated = { ...old, points: [...old.points, ...points] };
    stroke.current = updated;
    setMarks((all) => [...all.slice(0, -1), updated]);
  };
  const run = async (action: 'send' | 'save' | 'copy') => {
    const el = canvas.current;
    if (!el || !image || working) return;
    setWorking(true);
    try {
      // Paint synchronously so an immediately preceding pointer gesture is included.
      paintMarks(el, image, marks);
      const blob = await canvasPNG(el);
      if (action === 'send') {
        const source = session(serverId);
        if (!source || source.view.convs[convId]?.left) throw new Error('当前会话不能发送');
        await source.sendFile(convId, new File([blob], 'edited-image.png', { type: 'image/png' }));
        toast('已发送'); onClose();
      } else if (action === 'copy') {
        if (inTauri) {
          const { Image } = await import('@tauri-apps/api/image');
          const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
          const pixels = el.getContext('2d')!.getImageData(0, 0, el.width, el.height);
          const image = await Image.new(new Uint8Array(pixels.data.buffer), el.width, el.height);
          try { await writeImage(image); } finally { await image.close(); }
        } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        toast('已复制图片');
      } else if (inTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const dest = await save({ defaultPath: 'edited-image.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (!dest) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('save_edited_image', new Uint8Array(await blob.arrayBuffer()), { headers: { 'x-dest': encodeURIComponent(dest) } });
        toast('已保存');
      } else {
        const url = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = url; a.download = 'edited-image.png'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { toastError(e); }
    finally { setWorking(false); }
  };
  return (
    <Dialog open onClose={() => !working && onClose()} title="编辑图片" width={960}>
      {error ? <p role="alert">{error}</p> : !image ? <Spinner /> : <>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented id="image-tool" value={tool} onChange={setTool} options={[{ value: 'pen', label: '涂鸦' }, { value: 'mosaic', label: '马赛克' }, { value: 'emoji', label: '贴 emoji' }]} />
          {tool === 'pen' && <input type="color" aria-label="画笔颜色" value={color} onChange={(e) => setColor(e.target.value)} />}
          <div className="w-32"><Slider label="画笔大小" min={4} max={80} step={2} value={size} onChange={setSize} /></div>
          <Button size="sm" disabled={!marks.length || working} onClick={() => setMarks((all) => all.slice(0, -1))}><Undo2 size={16} />撤销</Button>
        </div>
        {tool === 'emoji' && <div className="mb-2 flex flex-wrap gap-1">{CHAT_EMOJI.map((item) => <button key={item} aria-pressed={item === emoji} className="press rounded-lg p-1 text-2xl aria-pressed:bg-accent/20" onClick={() => setEmoji(item)}>{item}</button>)}</div>}
        <div className="flex max-h-[58vh] justify-center overflow-auto rounded-xl bg-black/10">
          <canvas ref={canvas} width={image.width} height={image.height} style={{ maxWidth: '100%', maxHeight: '55vh', width: 'auto', height: 'auto', touchAction: 'none', cursor: 'crosshair' }} onPointerDown={down} onPointerMove={move} onPointerUp={() => { stroke.current = null; }} onPointerCancel={() => { stroke.current = null; }} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={working} onClick={() => run('copy')}><Copy size={16} />复制</Button>
          <Button disabled={working} onClick={() => run('save')}><Download size={16} />保存</Button>
          <Button variant="primary" disabled={working || session(serverId)?.view.status !== 'online'} onClick={() => run('send')}><SendHorizontal size={16} />发送</Button>
        </div>
      </>}
    </Dialog>
  );
}
