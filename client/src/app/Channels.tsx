// Channels (the protocol calls them groups): browse the public ones, create
// new ones. Public channels are open to everyone on the server and only site
// admins create them; private channels are invite only.
import { useEffect, useState } from 'react';
import { Globe, Lock } from 'lucide-react';
import { current, openConv } from '@/lib/store';
import type { SessionView } from '@/lib/session';
import type { ChannelInfo } from '@/lib/types';
import { Avatar, Button, Dialog, Field, Input, Segmented, Spinner, toast } from '@/ui';
import { useMediaUrl } from './media';
import { PersonPicker } from './People';

function ChannelRow({ ch, onDone }: { ch: ChannelInfo; onDone: () => void }) {
  const url = useMediaUrl(ch.avatar);
  return (
    <div className="lift flex items-center gap-3 rounded-2xl px-2.5 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/5">
      <Avatar src={url} name={ch.name} size={42} square />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{ch.name}</div>
        <div className="truncate text-[0.8rem] text-ink-soft dark:text-white/45">{ch.memberCount} 人{ch.notice ? ` · ${ch.notice}` : ''}</div>
      </div>
      {ch.joined ? (
        <Button size="sm" variant="soft" onClick={() => { openConv(ch.id); onDone(); }}>打开</Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => current().joinChannel(ch.id).then((id) => { openConv(id); onDone(); })}>加入</Button>
      )}
    </div>
  );
}

/** Every public channel; join the ones you left. */
export function BrowseChannelsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [list, setList] = useState<ChannelInfo[] | null>(null);
  useEffect(() => {
    if (!open) return;
    setList(null);
    current().listChannels().then(setList).catch(() => setList([]));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title="浏览公开频道" width={460}>
      <p className="-mt-2 mb-3 text-[0.85rem] text-ink-soft dark:text-white/50">公开频道所有人都能进。私密频道要有人邀请，这里看不到。</p>
      <div className="-mx-2 max-h-[55vh] space-y-0.5 overflow-y-auto px-2">
        {!list && <div className="flex justify-center py-8 text-ink-soft"><Spinner /></div>}
        {list?.map((ch) => <ChannelRow key={ch.id} ch={ch} onDone={onClose} />)}
        {list && !list.length && <p className="py-8 text-center text-ink-soft dark:text-white/50">还没有公开频道</p>}
      </div>
    </Dialog>
  );
}

/** New channel: private (pick members) or public (site admins; everyone joins). */
export function CreateChannelDialog({ open, onClose, v }: { open: boolean; onClose: () => void; v: SessionView }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'private' | 'public'>('private');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setKind('private');
      setSel(new Set());
    }
  }, [open]);
  const go = async () => {
    setBusy(true);
    try {
      const id = await current().createGroup(name.trim(), kind === 'public' ? [] : [...sel], kind === 'public');
      toast(kind === 'public' ? '公开频道建好了，所有人都已加入' : '频道建好了');
      openConv(id);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="新建频道" width={460}>
      <div className="space-y-4">
        <Field label="频道名"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="给频道起个名字" autoFocus /></Field>
        {v.isAdmin && (
          <Segmented
            id="channel-kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'private', label: <span className="flex items-center gap-1.5"><Lock size={14} />私密 · 邀请才能进</span> },
              { value: 'public', label: <span className="flex items-center gap-1.5"><Globe size={14} />公开 · 所有人</span> },
            ]}
          />
        )}
        {kind === 'private' ? (
          <Field label={`拉人进来（可以先不选）${sel.size ? ` · 已选 ${sel.size}` : ''}`}>
            <PersonPicker v={v} selected={sel} onChange={setSel} />
          </Field>
        ) : (
          <p className="rounded-2xl bg-accent-50 px-4 py-3 text-[0.88rem] text-accent-700 dark:bg-white/5 dark:text-accent-200">服务器上所有人都会自动加入，以后注册的新成员也会。</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={go}>新建</Button>
        </div>
      </div>
    </Dialog>
  );
}
