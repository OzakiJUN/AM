import { useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, MessageCircle, UserPlus, Users } from 'lucide-react';
import { current, openConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { User } from '@/lib/types';
import { Button, Dialog, Empty, Field, IdentityChip, Input, Segmented, cx, spring, toast, toastError } from '@/ui';
import { FriendPicker } from './Group';
import { ConvAvatar, UserAvatar } from './media';

type Tab = 'friends' | 'new' | 'groups';

export function ContactsPage({ v }: { v: SessionView }) {
  const [tab, setTab] = useState<Tab>('friends');
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const groups = Object.values(v.convs).filter((c) => c.kind === 'group' && !c.left);
  return (
    <section className="glass flex flex-1 flex-col overflow-hidden rounded-3xl">
      <header className="flex flex-wrap items-center gap-3 border-b border-black/5 px-6 py-4 dark:border-white/5">
        <h2 className="mr-2 text-[1.3rem] font-semibold">联系人</h2>
        <Segmented
          id="contacts"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'friends', label: `好友 ${v.friends.length || ''}` },
            { value: 'new', label: <span>新朋友{v.incoming.length > 0 && <span className="ml-1 rounded-full bg-rose-500 px-1.5 text-[0.7rem] text-white">{v.incoming.length}</span>}</span> },
            { value: 'groups', label: `群聊 ${groups.length || ''}` },
          ]}
        />
        <div className="flex-1" />
        <Button variant="soft" onClick={() => setCreating(true)}><Users size={16} />建群</Button>
        <Button variant="primary" onClick={() => setAdding(true)}><UserPlus size={16} />加好友</Button>
      </header>
      <div className="flex-1 overflow-y-auto p-6">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }} transition={spring}>
            {tab === 'friends' && (v.friends.length ? <Grid users={v.friends} /> : <Empty icon={<UserPlus size={28} />} title="还没有好友" text="点右上角「加好友」，输入对方的用户名。"><Button variant="primary" onClick={() => setAdding(true)}>加好友</Button></Empty>)}
            {tab === 'new' && <Requests v={v} />}
            {tab === 'groups' && (
              groups.length ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                  {groups.map((g) => (
                    <button key={g.id} onClick={() => openConv(g.id)} className="card flex items-center gap-3 rounded-2xl bg-white/80 p-3 text-left dark:bg-white/[0.06]">
                      <ConvAvatar conv={g} size={44} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{g.name}</div>
                        <div className="text-[0.82rem] text-ink-soft dark:text-white/50">{g.members.length} 位成员</div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : <Empty icon={<Users size={28} />} title="还没有群聊" text="拉几个好友建个群吧。"><Button variant="primary" onClick={() => setCreating(true)}>建群</Button></Empty>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <AddFriend open={adding} onClose={() => setAdding(false)} />
      <CreateGroup open={creating} onClose={() => setCreating(false)} v={v} />
    </section>
  );
}

function Grid({ users }: { users: User[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
      {users.map((u) => (
        <div key={u.id} className="card flex items-center gap-3 rounded-2xl bg-white/80 p-3 dark:bg-white/[0.06]">
          <UserAvatar user={u} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5"><span className="truncate font-medium">{u.name}</span><IdentityChip user={u} short /></div>
            <div className="truncate text-[0.82rem] text-ink-soft dark:text-white/50">@{u.username}</div>
          </div>
          <Button size="sm" variant="soft" onClick={() => current().openDM(u.id).then(openConv).catch(toastError)} aria-label={`和 ${u.name} 聊天`}>
            <MessageCircle size={15} />
          </Button>
        </div>
      ))}
    </div>
  );
}

function Requests({ v }: { v: SessionView }) {
  if (!v.incoming.length && !v.outgoing.length) return <Empty title="没有新的好友申请" />;
  return (
    <div className="space-y-6">
      {v.incoming.length > 0 && (
        <div>
          <h3 className="mb-3 text-[0.9rem] font-medium text-ink-soft dark:text-white/55">收到的申请</h3>
          <div className="space-y-2">
            {v.incoming.map((u) => (
              <div key={u.id} className="card flex items-center gap-3 rounded-2xl bg-white/80 p-3 dark:bg-white/[0.06]">
                <UserAvatar user={u} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-[0.82rem] text-ink-soft dark:text-white/50">@{u.username} 想加你为好友</div>
                </div>
                <Button variant="primary" size="sm" onClick={() => current().acceptFriend(u.id).then(() => toast(`已和 ${u.name} 成为好友`)).catch(toastError)}>
                  <Check size={15} /> 同意
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {v.outgoing.length > 0 && (
        <div>
          <h3 className="mb-3 text-[0.9rem] font-medium text-ink-soft dark:text-white/55">等待对方同意</h3>
          <div className="space-y-2">
            {v.outgoing.map((u) => (
              <div key={u.id} className={cx('flex items-center gap-3 rounded-2xl bg-white/50 p-3 dark:bg-white/[0.04]')}>
                <UserAvatar user={u} size={40} />
                <div className="min-w-0 flex-1 font-medium">{u.name} <span className="font-normal text-ink-soft">@{u.username}</span></div>
                <span className="text-[0.82rem] text-ink-soft">已发送</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AddFriend({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await current().requestFriend(name.trim().replace(/^@/, ''));
      toast('好友申请已发送');
      setName('');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="加好友">
      <form onSubmit={submit} className="space-y-4">
        <Field label="对方的用户名" hint="注册时填的那个，不是昵称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 xiaoke" autoFocus required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>发送申请</Button>
        </div>
      </form>
    </Dialog>
  );
}

function CreateGroup({ open, onClose, v }: { open: boolean; onClose: () => void; v: SessionView }) {
  const [name, setName] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const id = await current().createGroup(name.trim(), [...sel]);
      setName('');
      setSel(new Set());
      onClose();
      openConv(id);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="建群" width={460}>
      <div className="space-y-4">
        <Field label="群名"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="给群起个名字" autoFocus /></Field>
        <div>
          <div className="mb-1.5 text-[0.85rem] font-medium text-ink-soft dark:text-white/60">拉哪些好友（可以之后再邀请）</div>
          <FriendPicker friends={v.friends} selected={sel} onChange={setSel} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={go}>建群{sel.size ? `（${sel.size + 1} 人）` : ''}</Button>
        </div>
      </div>
    </Dialog>
  );
}
