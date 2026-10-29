// People on this server: there are no friends (Discord-style), so anyone can
// be found here, messaged or blocked. The picker is used to create private
// channels and to invite people into a channel.
import { useEffect, useRef, useState } from 'react';
import { Ban, Check, MessageCircle, Search } from 'lucide-react';
import { current, openConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { User } from '@/lib/types';
import { Button, Dialog, IdentityChip, Spinner, ask, cx } from '@/ui';
import { UserAvatar } from './media';

/** Searches the member directory (debounced) and pages with "load more". */
function usePeople(query: string, open: boolean) {
  const [users, setUsers] = useState<User[]>([]);
  const [next, setNext] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      current()
        .listUsers(query.trim())
        .then((r) => {
          if (my !== seq.current) return;
          setUsers(r.users);
          setNext(r.nextAfter);
        })
        .catch(() => my === seq.current && setUsers([]))
        .finally(() => my === seq.current && setLoading(false));
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [query, open]);
  const more = async () => {
    const r = await current().listUsers(query.trim(), next);
    setUsers((u) => [...u, ...r.users]);
    setNext(r.nextAfter);
  };
  return { users, loading, more: next ? more : undefined };
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative mb-3">
      <Search size={16} className="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-soft/70 dark:text-white/40" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="搜索用户名或昵称"
        aria-label="搜索成员"
        className="h-10 w-full rounded-xl bg-black/[0.04] pr-3 pl-9 outline-none transition-colors placeholder:text-ink-soft/60 focus:bg-white/80 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:bg-white/10"
      />
    </div>
  );
}

/** Opens (or creates) a DM and switches to it. */
export function messageUser(userId: string) {
  return current().openDM(userId).then(openConv);
}

/** Block / unblock with a confirmation; returns the ask() promise. */
export function toggleBlock(user: User | undefined, blocked: boolean) {
  if (!user) return;
  return blocked
    ? ask({ title: `取消屏蔽 ${user.name}？`, text: '之后你们又可以互发私信了。', ok: '取消屏蔽', run: () => current().setBlocked(user.id, false) })
    : ask({
        title: `屏蔽 ${user.name}？`, text: '屏蔽后你们不能互发私信，频道里照常。随时可以在 设置 → 隐私 里取消。', ok: '屏蔽', danger: true,
        run: () => current().setBlocked(user.id, true),
      });
}

/** Everyone on the server: search, send a DM, block. */
export function PeopleDialog({ open, onClose, v }: { open: boolean; onClose: () => void; v: SessionView }) {
  const [q, setQ] = useState('');
  const { users, loading, more } = usePeople(q, open);
  useEffect(() => {
    if (open) setQ('');
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={`「${v.name}」的成员`} width={480}>
      <SearchBox value={q} onChange={setQ} />
      <div className="-mx-2 max-h-[55vh] space-y-0.5 overflow-y-auto px-2">
        {users.map((u) => {
          const me = u.id === v.me?.id;
          const blocked = v.blocked.includes(u.id);
          return (
            <div key={u.id} className="lift flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-black/[0.03] dark:hover:bg-white/5">
              <UserAvatar user={u} size={38} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{u.name}</span>
                  <IdentityChip user={u} />
                </div>
                <div className="truncate text-[0.8rem] text-ink-soft dark:text-white/45">@{u.username}{blocked && ' · 已屏蔽'}</div>
              </div>
              {!me && (
                <>
                  <Button size="sm" variant="ghost" aria-label={blocked ? `取消屏蔽 ${u.name}` : `屏蔽 ${u.name}`} title={blocked ? '取消屏蔽' : '屏蔽'} onClick={() => toggleBlock(u, blocked)}>
                    <Ban size={15} className={blocked ? 'text-rose-500' : undefined} />
                  </Button>
                  <Button size="sm" variant="soft" disabled={blocked} onClick={() => messageUser(u.id).then(onClose)} aria-label={`私信 ${u.name}`}>
                    <MessageCircle size={15} /> 私信
                  </Button>
                </>
              )}
            </div>
          );
        })}
        {loading && <div className="flex justify-center py-6 text-ink-soft"><Spinner /></div>}
        {!loading && !users.length && <p className="py-8 text-center text-ink-soft dark:text-white/50">没有找到</p>}
        {more && !loading && <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={more}>加载更多</Button>}
      </div>
    </Dialog>
  );
}

/** Picks people from the directory (checkbox list with search). */
export function PersonPicker({ v, exclude, selected, onChange }: {
  v: SessionView; exclude?: Set<string>; selected: Set<string>; onChange: (s: Set<string>) => void;
}) {
  const [q, setQ] = useState('');
  const { users, loading, more } = usePeople(q, true);
  const list = users.filter((u) => u.id !== v.me?.id && !exclude?.has(u.id));
  const toggle = (id: string) => {
    const n = new Set(selected);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    onChange(n);
  };
  return (
    <div>
      <SearchBox value={q} onChange={setQ} />
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {list.map((u) => {
          const on = selected.has(u.id);
          return (
            <button
              key={u.id}
              onClick={() => toggle(u.id)}
              className={cx('lift flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left', on ? 'bg-accent-100 dark:bg-accent/15' : 'hover:bg-black/[0.03] dark:hover:bg-white/5')}
            >
              <UserAvatar user={u} size={34} />
              <span className="min-w-0 flex-1 truncate">{u.name} <span className="text-[0.8rem] text-ink-soft dark:text-white/45">@{u.username}</span></span>
              <IdentityChip user={u} short />
              <span className={cx('flex h-5 w-5 items-center justify-center rounded-md border-2 transition-colors', on ? 'border-accent bg-accent text-white' : 'border-black/20 dark:border-white/25')}>
                {on && <Check size={13} strokeWidth={3} />}
              </span>
            </button>
          );
        })}
        {loading && <div className="flex justify-center py-4 text-ink-soft"><Spinner /></div>}
        {!loading && !list.length && <p className="py-6 text-center text-ink-soft dark:text-white/50">没有可以选的人</p>}
        {more && !loading && <Button variant="ghost" size="sm" className="w-full" onClick={more}>加载更多</Button>}
      </div>
    </div>
  );
}
