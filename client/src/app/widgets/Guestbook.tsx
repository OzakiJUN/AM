// Guestbook widget: anyone can leave a short note. Nobody can edit or delete
// their own; the profile's owner can hide one; a site admin can delete one
// (the text is kept as evidence for a while, docs/design.md §7).
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { EyeOff, Eye, Send, Trash2 } from 'lucide-react';
import { listTime } from '@/lib/format';
import { current } from '@/lib/store';
import type { GuestEntry } from '@/lib/session';
import { Spinner, ask, cx, openMenu, toast, toastError, type MenuItem } from '@/ui';
import { UserAvatar } from '../media';
import type { WidgetCtx } from './Kinds';

const MAX = 200;

export function Guestbook({ ctx, widgetId, title }: { ctx: WidgetCtx; widgetId: string; title: string }) {
  const [list, setList] = useState<GuestEntry[] | null>(null);
  const [canHide, setCanHide] = useState(false);
  const [more, setMore] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = ctx.data.layout.widgets.some((w) => w.id === widgetId); // a new widget has no guestbook until saved

  const load = useCallback(() => {
    if (!saved) return;
    current().guestbook(ctx.target, widgetId).then((r) => {
      setList(r.entries);
      setMore(r.nextBefore);
      setCanHide(r.canHide);
    }).catch(toastError);
  }, [ctx.target, widgetId, saved]);
  useEffect(load, [load]);

  const older = () => current().guestbook(ctx.target, widgetId, more).then((r) => {
    setList((l) => [...(l ?? []), ...r.entries]);
    setMore(r.nextBefore);
  });

  async function post(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const entry = await current().postGuestbook(ctx.target, widgetId, t);
      setList((l) => [entry, ...(l ?? [])]);
      setText('');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const menu = (e: React.MouseEvent, en: GuestEntry) => {
    const items: MenuItem[] = [];
    if (canHide) {
      items.push({
        label: en.hidden ? '取消隐藏' : '隐藏这条留言', key: `gb-hide:${en.id}`, icon: en.hidden ? <Eye size={16} /> : <EyeOff size={16} />,
        onClick: () => current().hideGuestbook(en.id, !en.hidden).then(() => setList((l) => l && l.map((x) => (x.id === en.id ? { ...x, hidden: !en.hidden } : x)))),
      });
    }
    if (ctx.v.isAdmin) {
      items.push({
        label: '删除（管理员）', icon: <Trash2 size={16} />, danger: true,
        onClick: () => ask({
          title: '删除这条留言', text: '所有人都看不到了。原内容会作为证据保留一段时间。', ok: '删除', danger: true,
          input: { label: '原因', placeholder: '例如：广告、骂人', required: true },
          run: (reason) => current().deleteGuestbook(en.id, reason).then(() => {
            setList((l) => l && l.filter((x) => x.id !== en.id));
            toast('已删除');
          }),
        }),
      });
    }
    if (items.length) openMenu(e, items);
  };

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-1.5 flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate text-[0.95rem] font-semibold">💌 {title}</div>
        {list && <span className="text-[0.75rem] text-ink-soft dark:text-white/40">{list.length}{more ? '+' : ''} 条</span>}
      </div>
      <div className="-mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
        {!saved && <p className="py-4 text-center text-[0.8rem] text-ink-soft dark:text-white/40">保存主页后就能留言了</p>}
        {saved && !list && <div className="flex justify-center py-4 text-ink-soft"><Spinner size={16} /></div>}
        {list?.length === 0 && <p className="py-4 text-center text-[0.8rem] text-ink-soft dark:text-white/40">还没有留言，来写第一条吧</p>}
        {list?.map((en) => (
          <div
            key={en.id}
            onContextMenu={(e) => menu(e, en)}
            className={cx('flex gap-2 rounded-xl bg-black/[0.03] p-2 dark:bg-white/[0.04]', en.hidden && 'opacity-55')}
          >
            <UserAvatar user={en.author} size={26} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[0.72rem] text-ink-soft dark:text-white/45">
                <span className="truncate font-medium text-ink dark:text-white/80">{en.author?.name ?? '某人'}</span>
                <span className="shrink-0">{listTime(en.time)}</span>
                {en.hidden && <span className="shrink-0 rounded bg-black/10 px-1 dark:bg-white/10">已隐藏</span>}
                {(canHide || ctx.v.isAdmin) && (
                  <button onClick={(e) => menu(e, en)} aria-label="管理这条留言" className="ml-auto shrink-0 rounded px-1 hover:bg-black/5 dark:hover:bg-white/10">···</button>
                )}
              </div>
              <div className="selectable text-[0.85rem] break-words whitespace-pre-wrap">{en.text}</div>
            </div>
          </div>
        ))}
        {more && <button onClick={older} className="w-full py-1 text-center text-[0.78rem] text-accent-700 hover:underline dark:text-accent-200">更早的留言</button>}
      </div>
      {saved && !ctx.editing && (
        <form onSubmit={post} className="mt-2 flex items-center gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX}
            placeholder="写一句留言…"
            aria-label="留言"
            className="h-9 min-w-0 flex-1 rounded-xl bg-black/[0.04] px-3 text-[0.85rem] outline-none focus:bg-white/80 dark:bg-white/5 dark:focus:bg-white/10"
          />
          <button
            type="submit"
            aria-label="发送留言"
            disabled={!text.trim() || busy}
            aria-busy={busy || undefined}
            className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-50"
          >
            {busy ? <Spinner size={15} /> : <Send size={16} />}
          </button>
        </form>
      )}
    </div>
  );
}
