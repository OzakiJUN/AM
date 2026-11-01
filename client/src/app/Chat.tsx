import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle, Ban, Bot, Copy, Download, FileText, Hash, ImagePlus, Lock, Megaphone, MessageCircle, Mic, Paperclip, PanelRight, RotateCw,
  SendHorizontal, Settings2, Smile, Sparkles, Sticker, Strikethrough, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { chatTime, fileSize } from '@/lib/format';
import { usePrefs } from '@/lib/prefs';
import { activityText } from '@/lib/presence';
import { closeConv, current, openProfile, useOpenConv, type ConvPage } from '@/lib/store';
import { systemText, type SessionView } from '@/lib/session';
import type { Conversation, MemberRole, Message, User } from '@/lib/types';
import { applyMention, matchPeople, mentionParts, mentionQuery, mentionedIds } from '@/lib/mentions';
import { copyText } from '@/lib/platform';
import { Empty, IconButton, IdentityChip, RoleChip, Spinner, ask, cx, ease, openMenu, spring, toast, toastError, type MenuItem } from '@/ui';
import { GroupDialog, InviteDialog, MemberPanel } from './Group';
import { StickerManager, StickerPanel } from './Stickers';
import { UserAvatar, mediaPath, useMediaUrl } from './media';
import { toggleBlock } from './People';
import { GameBar, GameButton } from './Games';
import { PortraitCorner, PortraitOverlay, PortraitPosButton, hitPortrait, usePortraitPack } from './Portrait';
import { AISettingsDialog, askDeleteAI } from './AISettings';
import { useAI } from '@/lib/ai/runner';
import { voiceInput } from '@/lib/voice';
import { MOODS, pokeText, type Mood } from '@/lib/portraits';

const RANK: Record<MemberRole, number> = { owner: 3, admin: 2, member: 1 };

const EMPTY = {
  channels: { Icon: Hash, title: '选一个频道', text: '左边是你加入的频道。点 + 新建，或者浏览公开频道。' },
  dms: { Icon: MessageCircle, title: '选一个私信', text: '服务器里的人都能直接私信，点左边的成员按钮找人。' },
  ai: { Icon: Sparkles, title: '选一个 AI 开始聊天', text: '左边是你自己的 AI 和你添加的别人的 AI。' },
};

/**
 * One conversation on a page (频道 / 私信 / AI). On the AI page the AI's
 * portrait floats in the upper part (Portrait.tsx), above the messages.
 */
export function ChatView({ v, page }: { v: SessionView; page: ConvPage }) {
  const convId = useOpenConv(page, v.id);
  const membersFolded = usePrefs((p) => p.membersFolded);
  const setPrefs = usePrefs((p) => p.set);
  const [groupOpen, setGroupOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [aiOpen, setAIOpen] = useState(false);
  const [poked, setPoked] = useState(0);
  const [pokedMood, setPokedMood] = useState<Mood | undefined>();
  const lastPoke = useRef(0);
  const pokeDown = useRef<[number, number] | null>(null);
  const conv = convId ? v.convs[convId] : undefined;
  const streaming = useAI((s) => (convId ? s.streams[`${v.id}|${convId}`] : undefined));
  const aiError = useAI((s) => (conv?.peerId ? s.errors[`${v.id}|${conv.peerId}`] : undefined));
  // The AI's own portrait pack (default pack when it has none).
  const pack = usePortraitPack(v.id, page === 'ai' && conv ? v.users[conv.peerId ?? conv.aiId ?? ''] : undefined);
  if (!conv) {
    const { Icon, title, text } = EMPTY[page];
    return (
      <section className="glass flex flex-1 flex-col rounded-3xl">
        <Empty icon={<Icon size={28} />} title={title} text={text} />
      </section>
    );
  }
  const group = conv.kind === 'group';
  // The DM peer, or the AI of a shared AI room.
  const peer = conv.peerId ? v.users[conv.peerId] : conv.aiId ? v.users[conv.aiId] : undefined;
  const blocked = !!peer && v.blocked.includes(peer.id);
  const ai = page === 'ai';
  const peerPresence = peer ? v.presence[peer.id] : undefined;
  const myAI = ai && !!peer && peer.ownerId === v.me?.id;
  const mood = pokedMood ?? aiMood(v, conv.id, peer?.id, streaming);
  // Poking the portrait: a click on the figure (not on the empty space around it) sends "[戳一戳] …".
  const poke = (e: React.MouseEvent) => {
    if (!ai || !peer || !peerPresence || conv.left || blocked) return;
    const down = pokeDown.current;
    if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; // a drag (selecting text)
    const part = hitPortrait(e.currentTarget as HTMLElement, e.clientX, e.clientY);
    if (!part) return;
    e.preventDefault();
    e.stopPropagation();
    if (Date.now() - lastPoke.current < 2500) return;
    lastPoke.current = Date.now();
    setPoked((n) => n + 1);
    setPokedMood('surprised');
    setTimeout(() => setPokedMood(undefined), 1600);
    current().sendText(conv.id, pokeText(part, peer.name)).catch(toastError);
  };
  return (
    <>
      <section className="glass relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-3xl">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-black/5 px-5 dark:border-white/5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {group && (conv.public ? <Hash size={17} className="shrink-0 text-ink-soft" /> : <Lock size={15} className="shrink-0 text-ink-soft" aria-label="私密频道" />)}
              <h2 className="truncate text-[1.1rem] font-semibold">{conv.name}</h2>
              <IdentityChip user={peer} />
            </div>
            <div className="truncate text-[0.8rem] text-ink-soft dark:text-white/50">
              {group
                ? `${conv.public ? '公开频道' : '私密频道'} · ${conv.members.length} 人`
                : peer ? `@${peer.username} · ${peerPresence ? activityText(peerPresence.activity) || '在线' : '离线'}` : ''}
              {conv.left && ' · 你已不在这个频道里'}
              {blocked && ' · 已屏蔽'}
            </div>
          </div>
          {group && !conv.left && (
            <>
              <GameButton v={v} conv={conv} />
              <IconButton label="邀请成员" onClick={() => setInviteOpen(true)}><UserPlus size={19} /></IconButton>
              {!conv.aiId && v.me?.type === 'human' && <IconButton label="添加 bot" onClick={(e) => addBotMenu(e, v, conv)}><Bot size={19} /></IconButton>}
              <IconButton label="频道设置" onClick={() => setGroupOpen(true)}><Settings2 size={19} /></IconButton>
              <IconButton label={membersFolded ? '展开成员列表' : '收起成员列表'} active={!membersFolded} onClick={() => setPrefs({ membersFolded: !membersFolded })}><PanelRight size={19} /></IconButton>
            </>
          )}
          {!group && peer && !myAI && (
            <IconButton label={blocked ? '取消屏蔽' : '屏蔽'} active={blocked} onClick={() => toggleBlock(peer, blocked)}><Ban size={18} /></IconButton>
          )}
          {myAI && !group && <IconButton label="删除 AI" onClick={() => askDeleteAI(v.id, peer.id, () => closeConv('ai', v.id))}><Trash2 size={18} /></IconButton>}
          {myAI && <IconButton label="AI 设置" onClick={() => setAIOpen(true)}><Settings2 size={19} /></IconButton>}
          {ai && peer && <PortraitPosButton />}
          {ai && peer && <PortraitCorner user={peer} online={!!peerPresence} mood={mood} pack={pack} />}
        </header>
        {group && <GameBar v={v} conv={conv} />}
        <div
          className="relative flex min-h-0 flex-1 flex-col"
          onPointerDownCapture={ai ? (e) => { pokeDown.current = [e.clientX, e.clientY]; } : undefined}
          onClickCapture={ai ? poke : undefined}
          onMouseMove={ai && peer ? (e) => { e.currentTarget.style.cursor = hitPortrait(e.currentTarget, e.clientX, e.clientY) ? 'pointer' : ''; } : undefined}
        >
          <MessageList key={conv.id} v={v} conv={conv} streaming={streaming} fromBottom={ai} />
          {ai && peer && <PortraitOverlay user={peer} online={!!peerPresence} mood={mood} pack={pack} poked={poked} />}
        </div>
        {myAI && aiError && (
          <div className="mx-4 mb-1 flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-[0.82rem] text-rose-700 dark:bg-rose-400/10 dark:text-rose-200" role="alert">
            <AlertCircle size={15} className="shrink-0" />
            <span className="min-w-0 flex-1">它没能回复：{aiError}</span>
            <button onClick={() => setAIOpen(true)} className="shrink-0 underline">打开设置</button>
          </div>
        )}
        <Composer v={v} conv={conv} blocked={blocked} />
        {myAI && peer && <AISettingsDialog open={aiOpen} onClose={() => setAIOpen(false)} aiId={peer.id} />}
      </section>
      <AnimatePresence initial={false}>
        {group && !conv.left && (
          <motion.div
            key="members"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={spring}
            className="flex shrink-0"
          >
            <MemberPanel v={v} conv={conv} onInvite={() => setInviteOpen(true)} />
          </motion.div>
        )}
      </AnimatePresence>
      {group && <GroupDialog open={groupOpen} onClose={() => setGroupOpen(false)} v={v} conv={conv} />}
      {group && <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} v={v} conv={conv} />}
    </>
  );
}

// ---------- messages ----------

/** The AI's mood for its portrait: `typing` while it writes, else its last reply's mood. */
function aiMood(v: SessionView, convId: string, aiId: string | undefined, streaming: string | undefined): Mood | undefined {
  if (!aiId) return undefined;
  if (streaming !== undefined) return 'typing';
  const list = v.messages[convId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.senderId !== aiId) continue;
    const mood = m.body.kind === 'text' ? m.body.mood : undefined;
    return mood && (MOODS as readonly string[]).includes(mood) ? (mood as Mood) : 'neutral';
  }
  return undefined;
}

/**
 * fromBottom (AI chats): a short conversation sits at the bottom and grows
 * upwards, so the portrait at the top never hides the newest messages.
 */
function MessageList({ v, conv, streaming, fromBottom }: { v: SessionView; conv: Conversation; streaming?: string; fromBottom?: boolean }) {
  const list = v.messages[conv.id] ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef(0);
  const mountedAt = useRef(Date.now());
  const [viewer, setViewer] = useState<string | null>(null);

  // Keep the newest message in view, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (loadingOlder.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
      loadingOlder.current = false;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [list, streaming]);

  // Read up to the newest message while the conversation is on screen.
  useEffect(() => {
    const mark = () => document.hasFocus() && atBottom.current && current().markRead(conv.id);
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [conv.id, conv.lastSeq]);

  const onScroll = useCallback(() => {
    const el = ref.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current) current().markRead(conv.id);
    if (el.scrollTop < 80 && v.hasOlder[conv.id] && !loadingOlder.current) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      current().loadOlder(conv.id).catch(() => (loadingOlder.current = false));
    }
  }, [conv.id, v.hasOlder]);

  const items: ReactNode[] = [];
  let last = 0;
  let prevSender = '';
  for (const m of list) {
    const gap = m.time - last > 5 * 60_000;
    if (gap) items.push(<div key={'t' + m.id} className="py-2 text-center text-[0.75rem] text-ink-soft/80 dark:text-white/35">{chatTime(m.time)}</div>);
    const grouped = !gap && prevSender === m.senderId && m.body.kind !== 'system' && m.body.kind !== 'deleted';
    last = m.time;
    prevSender = m.body.kind === 'system' ? '' : m.senderId;
    items.push(<MessageItem key={m.id} v={v} conv={conv} msg={m} grouped={grouped} animate={m.time > mountedAt.current} onView={setViewer} />);
  }
  return (
    <div ref={ref} onScroll={onScroll} className={cx('selectable relative flex-1 overflow-y-auto px-5 py-4', fromBottom && 'flex flex-col')}>
      {fromBottom && <div className="flex-1" aria-hidden />}
      {v.hasOlder[conv.id] && <div className="flex justify-center py-2 text-ink-soft"><Spinner size={16} /></div>}
      {conv.notice && (
        <div className="mx-auto mb-3 flex max-w-xl items-start gap-2 rounded-2xl bg-amber-50/80 px-4 py-2.5 text-[0.85rem] text-amber-800 shadow-[var(--shadow-card)] dark:bg-amber-400/10 dark:text-amber-200">
          <Megaphone size={16} className="mt-0.5 shrink-0" />
          <span className="whitespace-pre-wrap">频道公告：{conv.notice}</span>
        </div>
      )}
      {!list.length && streaming === undefined && <p className="py-16 text-center text-ink-soft dark:text-white/45">还没有消息，打个招呼吧 👋</p>}
      {items}
      {streaming !== undefined && conv.peerId && <StreamingReply v={v} aiId={conv.peerId} text={streaming} />}
      <ImageViewer mediaId={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

const MessageItem = memo(function MessageItem({ v, conv, msg, grouped, animate, onView }: {
  v: SessionView; conv: Conversation; msg: Message; grouped: boolean; animate: boolean; onView: (id: string) => void;
}) {
  const b = msg.body;
  const name = (id: string) => v.users[id]?.name ?? (id === v.me?.id ? v.me?.name ?? '我' : '某人');
  const enter = animate ? { initial: { opacity: 0, y: 10, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: spring } : {};
  if (b.kind === 'system' || b.kind === 'deleted') {
    return (
      <motion.div {...enter} className="flex justify-center py-1.5">
        <span
          className={cx(
            'rounded-full px-3 py-1 text-[0.78rem] text-ink-soft dark:text-white/45',
            b.kind === 'deleted' ? 'border border-dashed border-black/10 dark:border-white/15' : 'bg-black/[0.04] dark:bg-white/5',
          )}
        >
          {b.kind === 'system' ? systemText(b.sys, name) : `${name(msg.senderId)} 的一条消息已被 ${name(b.byId)} 删除（原因：${b.reason}）`}
        </span>
      </motion.div>
    );
  }
  const mine = msg.senderId === v.me?.id;
  const sender = v.users[msg.senderId] ?? (mine ? v.me : undefined);
  const roleOf = (id: string) => conv.members.find((m) => m.userId === id)?.role;
  const role = conv.kind === 'group' ? roleOf(msg.senderId) : undefined;

  const menu = (e: React.MouseEvent) => {
    const s = current();
    const items: MenuItem[] = [];
    if (b.kind === 'text') items.push({ label: '复制', icon: <Copy size={16} />, onClick: () => copyText(b.text) });
    if (b.kind === 'image') items.push({ label: '查看原图', icon: <ImagePlus size={16} />, onClick: () => onView(b.mediaId) });
    if (b.kind === 'image' || b.kind === 'file') {
      items.push({
        label: b.kind === 'image' ? '保存图片' : '下载文件', icon: <Download size={16} />, key: `dl:${b.mediaId}`,
        onClick: () => s.t.download(mediaPath(b.mediaId), b.kind === 'file' ? b.name : `image-${b.mediaId}.png`).catch(toastError),
      });
    }
    if (msg.failed) {
      if (b.kind === 'text') items.push({ label: '重新发送', icon: <RotateCw size={16} />, onClick: () => { s.dropFailed(conv.id, msg.id); s.sendText(conv.id, b.text).catch(toastError); } });
      items.push({ label: '删掉这条', icon: <Trash2 size={16} />, danger: true, onClick: () => s.dropFailed(conv.id, msg.id) });
    } else if (!msg.pending) {
      if (mine && !msg.struck && !conv.left) {
        items.push({
          label: '划掉', icon: <Strikethrough size={16} />,
          onClick: () => ask({ title: '划掉这条消息？', text: '消息会加上删除线，大家仍然能看到原文。划掉后不能撤销。', ok: '划掉', run: () => s.strike(conv.id, msg.id) }),
        });
      }
      const myRank = RANK[conv.myRole];
      if (conv.kind === 'group' && !mine && myRank >= 2 && myRank > RANK[role ?? 'member'] && !conv.left) {
        items.push({
          label: '删除（管理员）', icon: <Trash2 size={16} />, danger: true,
          onClick: () => ask({
            title: '删除这条消息', text: '所有人都会看不到它，原位置留下删除记录。原内容会作为证据交给服主保管。', ok: '删除', danger: true,
            input: { label: '原因', placeholder: '例如：广告、刷屏', required: true },
            run: (reason) => s.adminDelete(msg.id, reason).then(() => toast('已删除')),
          }),
        });
      }
    }
    openMenu(e, items);
  };

  return (
    <motion.div {...enter} className={cx('group flex gap-3', grouped ? 'pt-1' : 'pt-3', mine && 'flex-row-reverse')} onContextMenu={menu}>
      <div className="w-[38px] shrink-0">
        {!grouped && (
          <button onClick={() => openProfile(msg.senderId)} className="press rounded-full" aria-label={`${sender?.name ?? '对方'}的主页`} title="看主页">
            <UserAvatar user={sender} size={38} animated />
          </button>
        )}
      </div>
      <div className={cx('flex max-w-[68%] min-w-0 flex-col', mine ? 'items-end' : 'items-start')}>
        {!mine && !grouped && (
          <div className="mb-1 flex items-center gap-1.5 text-[0.8rem]">
            <span className="text-ink-soft dark:text-white/60">{sender?.name ?? '某人'}</span>
            <RoleChip role={role} />
            <IdentityChip user={sender} />
          </div>
        )}
        <div className={cx('flex items-end gap-2', mine && 'flex-row-reverse')}>
          <Body msg={msg} mine={mine} onView={onView} />
          {msg.pending && !msg.failed && <span className="mb-1 text-ink-soft"><Spinner size={13} /></span>}
          {msg.failed && (
            <button onClick={menu} title={msg.failed} className="mb-1 text-rose-500" aria-label="发送失败">
              <AlertCircle size={18} />
            </button>
          )}
        </div>
        {msg.struck && (
          <span className="mt-1 flex items-center gap-1 text-[0.72rem] text-ink-soft dark:text-white/40"><Strikethrough size={12} /> 已划掉</span>
        )}
      </div>
    </motion.div>
  );
});

/** The AI's reply while it is being written (only on the device that runs it). */
function StreamingReply({ v, aiId, text }: { v: SessionView; aiId: string; text: string }) {
  const ai = v.users[aiId];
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="flex gap-3 pt-3" aria-live="polite">
      <div className="w-[38px] shrink-0"><UserAvatar user={ai} size={38} /></div>
      <div className="flex max-w-[68%] min-w-0 flex-col items-start">
        <div className="mb-1 text-[0.8rem] text-ink-soft dark:text-white/60">{ai?.name ?? 'AI'} 正在输入…</div>
        <div className="card rounded-2xl rounded-tl-md bg-white/95 px-3.5 py-2 whitespace-pre-wrap break-words dark:bg-white/[0.07]">
          {text || <span className="inline-flex gap-1 py-1">{[0, 1, 2].map((i) => <motion.span key={i} className="h-1.5 w-1.5 rounded-full bg-ink-soft/60" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }} />)}</span>}
        </div>
      </div>
    </motion.div>
  );
}

function Body({ msg, mine, onView }: { msg: Message; mine: boolean; onView: (id: string) => void }) {
  const b = msg.body;
  const thumb = useMediaUrl(b.kind === 'image' ? mediaPath(b.mediaId, true) : undefined);
  if (b.kind === 'image' && b.stickerTags) {
    // A sticker: small, no frame, its tags as the tooltip.
    const ratio = b.w && b.h ? b.w / b.h : 1;
    return (
      <button onClick={() => onView(b.mediaId)} className={cx('press block', msg.struck && 'opacity-60 grayscale')} style={{ width: Math.min(150, 150 * ratio), aspectRatio: String(ratio) }} aria-label={`表情：${b.stickerTags.join('、')}`} title={b.stickerTags.join('、')}>
        {thumb && <img src={thumb} alt={b.stickerTags.join('、')} className="h-full w-full object-contain" draggable={false} />}
      </button>
    );
  }
  if (b.kind === 'image') {
    const ratio = b.w && b.h ? b.w / b.h : 4 / 3;
    const w = Math.min(320, ratio >= 1 ? 320 : 240 * ratio);
    return (
      <button
        onClick={() => onView(b.mediaId)}
        className={cx('card overflow-hidden rounded-2xl bg-black/5 dark:bg-white/5', msg.struck && 'opacity-60 grayscale')}
        style={{ width: w, aspectRatio: String(ratio) }}
        aria-label="查看图片"
      >
        {thumb && <img src={thumb} alt="图片" className="h-full w-full object-cover" draggable={false} />}
      </button>
    );
  }
  if (b.kind === 'file') {
    return (
      <div className={cx('card flex w-72 items-center gap-3 rounded-2xl bg-white/90 p-3 dark:bg-white/10', msg.struck && 'line-through opacity-60')}>
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300">
          <FileText size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={b.name}>{b.name}</div>
          <div className="text-[0.78rem] text-ink-soft dark:text-white/45">{fileSize(b.size)}</div>
        </div>
        {!msg.pending && (
          <IconButton label="下载" onClick={() => current().t.download(mediaPath(b.mediaId), b.name).then((ok) => ok && toast('已保存')).catch(toastError)}>
            <Download size={18} />
          </IconButton>
        )}
      </div>
    );
  }
  if (b.kind !== 'text') return null;
  const names = (id: string) => current().nameOf(id);
  return (
    <div
      className={cx(
        'rounded-2xl px-4 py-2.5 leading-relaxed break-words whitespace-pre-wrap shadow-[var(--shadow-card)] transition-[transform,box-shadow] duration-300 ease-[var(--ease-out)]',
        mine ? 'rounded-tr-md bg-accent text-white' : 'rounded-tl-md bg-white/90 dark:bg-white/10',
        msg.struck && 'line-through decoration-2 opacity-60',
        msg.pending && 'opacity-70',
      )}
    >
      {b.mentions?.length
        ? mentionParts(b.text, b.mentions.map((id) => names(id))).map((p, i) => (p.mention
          ? <span key={i} className={cx('rounded px-0.5 font-medium', mine ? 'bg-white/25' : 'bg-accent-100 text-accent-700 dark:bg-accent/25 dark:text-accent-100')}>{p.text}</span>
          : <span key={i}>{p.text}</span>))
        : b.text}
    </div>
  );
}

function ImageViewer({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const url = useMediaUrl(mediaId ? mediaPath(mediaId) : undefined);
  useEffect(() => {
    if (!mediaId) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [mediaId, onClose]);
  return (
    <AnimatePresence>
      {mediaId && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-10 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={ease}
          onClick={onClose}
        >
          {url ? (
            <motion.img
              src={url}
              alt="图片"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={spring}
              className="max-h-full max-w-full rounded-xl shadow-2xl"
            />
          ) : (
            <span className="text-white"><Spinner size={28} /></span>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- composer ----------

const EMOJI = '😀😂🤣😊😍🥰😘😎🤔😅😭😡🥺😴🤯👍👎👏🙏💪🎉❤️🔥✨💯🤝👀🫡🥳😇😋🤗😏😬🙄😱🤤'.match(/\p{Extended_Pictographic}️?/gu)!;

function Composer({ v, conv, blocked }: { v: SessionView; conv: Conversation; blocked: boolean }) {
  const [text, setText] = useState('');
  // @-mentions (channels): who was picked from the list, and the list being shown.
  const picked = useRef(new Map<string, string>());
  const [at, setAt] = useState<{ start: number; query: string; index: number } | null>(null);
  const people = at && conv.kind === 'group'
    ? matchPeople(conv.members.map((m) => v.users[m.userId]).filter((u): u is User => !!u && u.id !== v.me?.id && !u.gone), at.query)
    : [];
  const [emoji, setEmoji] = useState(false);
  const [stickers, setStickers] = useState(false);
  const [manage, setManage] = useState(false);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const muted = conv.mutedUntil > Date.now();
  const disabled = !!conv.left || muted || blocked || v.status !== 'online';

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    current().sendText(conv.id, t, undefined, mentionedIds(t, picked.current)).catch(toastError);
    setText('');
    picked.current.clear();
    setAt(null);
  };
  const onText = (value: string, caret: number) => {
    setText(value);
    const q = conv.kind === 'group' ? mentionQuery(value, caret) : null;
    setAt(q ? { ...q, index: 0 } : null);
  };
  const pick = (u: User) => {
    const ta = taRef.current;
    if (!at || !ta) return;
    const r = applyMention(text, at.start, ta.selectionStart, u.name);
    picked.current.set(u.id, u.name);
    setText(r.text);
    setAt(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.caret, r.caret);
    });
  };
  const sendFiles = async (files: File[]) => {
    if (disabled || !files.length) return;
    setBusy(true);
    try {
      for (const f of files) await current().sendFile(conv.id, f);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // Drag & drop anywhere on the chat panel.
  useEffect(() => {
    const panel = taRef.current?.closest('section');
    if (!panel) return;
    let depth = 0;
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDrag(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDrag(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDrag(false);
      sendFiles([...(e.dataTransfer?.files ?? [])]);
    };
    panel.addEventListener('dragover', over);
    panel.addEventListener('dragenter', enter);
    panel.addEventListener('dragleave', leave);
    panel.addEventListener('drop', drop);
    return () => {
      panel.removeEventListener('dragover', over);
      panel.removeEventListener('dragenter', enter);
      panel.removeEventListener('dragleave', leave);
      panel.removeEventListener('drop', drop);
    };
  });

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(160, Math.max(52, ta.scrollHeight)) + 'px';
  }, [text]);

  const placeholder = conv.left ? '你已经不在这个频道里了' : muted ? '你被禁言了' : blocked ? '你屏蔽了对方，取消屏蔽后才能发消息' : v.status !== 'online' ? '正在连接服务器…' : '说点什么…（Enter 发送，Shift+Enter 换行）';
  return (
    <div className="relative shrink-0 px-4 pb-4">
      <AnimatePresence>
        {drag && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={ease}
            className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-[2px]"
          >
            <div className="flex items-center gap-2 rounded-2xl bg-white/90 px-6 py-4 font-medium text-accent-700 shadow-xl dark:bg-[#221f3c]/90 dark:text-accent-200">
              <Upload size={20} /> 松开发送到「{conv.name}」
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className={cx('rounded-2xl border border-black/5 bg-white/95 p-2 shadow-[var(--shadow-card)] transition-[border-color,box-shadow] duration-300 focus-within:border-accent-300 focus-within:shadow-[var(--shadow-lift)] dark:border-white/10 dark:bg-white/5', disabled && 'opacity-70')}>
        <div className="relative flex items-center gap-0.5 px-1">
          <IconButton label="表情" active={emoji} onClick={() => { setEmoji(!emoji); setStickers(false); }} disabled={disabled}><Smile size={19} /></IconButton>
          <IconButton label="表情包" active={stickers} onClick={() => { setStickers(!stickers); setEmoji(false); }} disabled={disabled}><Sticker size={19} /></IconButton>
          <IconButton label="发送图片" onClick={() => imgRef.current?.click()} disabled={disabled}><ImagePlus size={19} /></IconButton>
          <IconButton label="发送文件" onClick={() => fileRef.current?.click()} disabled={disabled}><Paperclip size={19} /></IconButton>
          {/* Voice input: the slot only (lib/voice.ts); the wrapper keeps the tooltip on the disabled button. */}
          <span title={voiceInput.available ? '语音输入' : '语音输入以后上线'} className="inline-flex">
            <IconButton label="语音输入" disabled={disabled || !voiceInput.available} className="disabled:opacity-40"><Mic size={19} /></IconButton>
          </span>
          {busy && <span className="ml-2 flex items-center gap-1.5 text-[0.8rem] text-ink-soft"><Spinner size={13} /> 上传中…</span>}
          <AnimatePresence>
            {stickers && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
                transition={spring}
                style={{ transformOrigin: 'bottom left' }}
                className="glass-strong absolute bottom-full left-0 z-20 mb-2 rounded-2xl p-1.5 shadow-xl"
              >
                <StickerPanel
                  serverId={v.id}
                  onSend={(s) => { current().sendSticker(conv.id, s).catch(toastError); setStickers(false); }}
                  onManage={() => { setStickers(false); setManage(true); }}
                />
              </motion.div>
            )}
          </AnimatePresence>
          <StickerManager serverId={v.id} open={manage} onClose={() => setManage(false)} />
          <AnimatePresence>
            {at && people.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
                transition={spring}
                style={{ transformOrigin: 'bottom left' }}
                role="listbox"
                aria-label="提到谁"
                className="glass-strong absolute bottom-full left-0 z-20 mb-2 w-64 rounded-2xl p-1.5 shadow-xl"
              >
                {people.map((u, i) => (
                  <button
                    key={u.id}
                    role="option"
                    aria-selected={i === at.index}
                    onMouseDown={(e) => { e.preventDefault(); pick(u); }}
                    onMouseEnter={() => setAt({ ...at, index: i })}
                    className={cx('flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left', i === at.index ? 'bg-accent-100 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5')}
                  >
                    <UserAvatar user={u} size={26} />
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    <IdentityChip user={u} short />
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {emoji && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.12 } }}
                transition={spring}
                style={{ transformOrigin: 'bottom left' }}
                className="glass-strong absolute bottom-full left-0 z-20 mb-2 grid w-80 grid-cols-8 gap-1 rounded-2xl p-2 shadow-xl"
              >
                {EMOJI.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      setText((t) => t + e);
                      taRef.current?.focus();
                    }}
                    className="press flex h-9 items-center justify-center rounded-lg text-[1.3rem] hover:bg-accent-50 dark:hover:bg-white/10"
                  >
                    {e}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onText(e.target.value, e.target.selectionStart)}
            onKeyDown={(e) => {
              if (at && people.length && !e.nativeEvent.isComposing) {
                const n = people.length;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAt({ ...at, index: (at.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pick(people[Math.min(at.index, n - 1)]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setAt(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              // Screenshots arrive as clipboard items; files copied in Explorer as files.
              let files = [...e.clipboardData.files];
              if (!files.length) files = [...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
              if (files.length) {
                e.preventDefault();
                sendFiles(files);
              }
            }}
            onFocus={() => { setEmoji(false); setStickers(false); }}
            disabled={disabled}
            rows={1}
            placeholder={placeholder}
            aria-label="消息"
            className="flex-1 resize-none bg-transparent px-2 py-1.5 outline-none placeholder:text-ink-soft/60 dark:placeholder:text-white/30"
          />
          <motion.button
            onClick={submit}
            disabled={!text.trim() || disabled}
            aria-label="发送"
            whileTap={{ scale: 0.9 }}
            transition={spring}
            className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-[0_6px_16px_-6px_var(--accent)] transition-[background,opacity,box-shadow] hover:bg-accent-600 disabled:opacity-40 disabled:shadow-none"
          >
            <SendHorizontal size={19} />
          </motion.button>
        </div>
      </div>
      <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={(e) => { sendFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { sendFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
    </div>
  );
}

/** "添加 bot": my own AIs that are not in this channel yet (private channels may need approval). */
function addBotMenu(e: React.MouseEvent, v: SessionView, conv: Conversation) {
  const mine = (useAI.getState().byServer[v.id] ?? []).map((a) => a.user).filter((u) => !u.gone);
  const out = mine.filter((u) => !conv.members.some((m) => m.userId === u.id));
  if (!mine.length) return toast('你还没有自己的 AI，去 AI 页新建一个');
  if (!out.length) return toast('你的 AI 都在这个频道里了');
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu({ clientX: r.left, clientY: r.bottom + 6 }, out.map((u) => ({
    label: `拉 ${u.name} 进来`,
    icon: <Bot size={15} />,
    key: `addbot:${conv.id}:${u.id}`,
    onClick: async () => {
      const res = await current().inviteMembers(conv.id, [u.id]);
      toast(res.requested.length ? '已经申请了，等频道管理员同意' : `${u.name} 进频道了`);
    },
  })));
}
