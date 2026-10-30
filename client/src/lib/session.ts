// One logged-in server: HTTP calls, the WebSocket (auth, sync, pushes,
// reconnect) and the state the UI shows. See docs/protocol.md.
import { create, fromBinary, fromJsonString, toBinary, toJsonString, type DescMessage, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf';
import * as api from '@/gen/am/v1/api_pb';
import * as common from '@/gen/am/v1/common_pb';
import * as ev from '@/gen/am/v1/event_pb';
import * as gw from '@/gen/am/v1/gateway_pb';
import * as pf from '@/gen/am/v1/profile_pb';
import { ApiError, errorFromBody } from './errors';
import { encodeJoinCode, joinUrl } from './joincode';
import { createTransport, type Endpoint, type Socket, type Transport } from './transport';
import type { Part as SyncPart } from './profileSync';
import type { Background, LayoutModel, WidgetModel } from './widgets';
import type { Activity, ActivityKind, ChannelInfo, Conversation, Invite, JoinRequest, MemberRole, Message, MessageBody, Presence, SysEvent, User } from './types';

export interface ServerRecord {
  id: string;
  endpoint: Endpoint;
  name: string;
  token?: string;
  userId?: string;
}

export type Status = 'connecting' | 'online' | 'offline' | 'logged_out';

export interface SessionView {
  id: string;
  name: string;
  status: Status;
  error?: string;
  me?: User;
  users: Record<string, User>;
  convs: Record<string, Conversation>;
  messages: Record<string, Message[]>;
  /** Conversations whose older history can still be loaded. */
  hasOlder: Record<string, boolean>;
  /** Site admin of this server (may create public channels). */
  isAdmin: boolean;
  /** Ids of people I blocked. */
  blocked: string[];
  joinRequests: Record<string, JoinRequest[]>;
  downloadUrl: string;
  /** Who is online, as I see them (user id -> presence). Empty while disconnected. */
  presence: Record<string, Presence>;
  /** Server icon (media path), '' when none. */
  icon: string;
}

/** A profile page: the widget board and what the viewer may do with it. */
export interface ProfileData {
  layout: LayoutModel;
  canEditLayout: boolean;
  /** Widgets whose contents the viewer may change. */
  editable: string[];
  /** Site admin on the server profile: may set who edits each widget. */
  canSetEditors: boolean;
  stats: { messages: number; streakDays: number; joinedAt: number; members: number; channels: number; createdAt: number };
  /** User profiles: the user. */
  user?: User;
}

export interface GuestEntry {
  id: string;
  author?: User;
  text: string;
  time: number;
  hidden: boolean;
}

/** 'server' or a user id. */
export type ProfileTarget = string;
const profilePath = (t: ProfileTarget) => (t === 'server' ? '/api/v1/profiles/server' : `/api/v1/profiles/users/${t}`);

const cellFrom = (c?: pf.Cell) => ({ page: c?.page ?? 0, x: c?.x ?? 0, y: c?.y ?? 0 });

function toWidget(w: pf.Widget): WidgetModel {
  let config: Record<string, unknown> = {};
  try {
    const c = JSON.parse(w.config || '{}');
    if (c && typeof c === 'object' && !Array.isArray(c)) config = c;
  } catch {
    /* bad JSON from an old client: show defaults */
  }
  return {
    id: w.id, kind: w.kind, source: w.source === pf.WidgetSource.WORKSHOP ? 'workshop' : 'builtin',
    w: w.w, h: w.h, land: cellFrom(w.landscape), port: w.portrait ? cellFrom(w.portrait) : undefined, config,
    contentEditors: w.contentEditors === pf.WidgetEditors.ADMINS ? 'admins' : 'everyone',
    workshop: w.workshopId ? { id: w.workshopId, version: w.workshopVersion, sha256: w.packageSha256 } : undefined,
    snapshotMediaId: s(w.snapshotMediaId) || undefined,
  };
}

function toLayout(l?: pf.ProfileLayout): LayoutModel {
  const bg = l?.background;
  const background: Background = {
    kind: (['color', 'gradient', 'image'].includes(bg?.kind ?? '') ? bg!.kind : '') as Background['kind'],
    value: bg?.value ?? '', mediaId: bg ? s(bg.mediaId) || undefined : undefined, blur: bg?.blur ?? 0, dim: bg?.dim ?? 0,
  };
  return { widgets: (l?.widgets ?? []).map(toWidget), portraitCustom: !!l?.portraitCustom, background, version: Number(l?.version ?? 0n) };
}

function fromLayout(l: LayoutModel) {
  return {
    portraitCustom: l.portraitCustom,
    background: { kind: l.background.kind, value: l.background.value, mediaId: BigInt(l.background.mediaId || 0), blur: l.background.blur, dim: l.background.dim },
    widgets: l.widgets.map((w) => ({
      id: w.id, kind: w.kind, source: w.source === 'workshop' ? pf.WidgetSource.WORKSHOP : pf.WidgetSource.BUILTIN,
      w: w.w, h: w.h, landscape: w.land, portrait: l.portraitCustom ? w.port : undefined, config: JSON.stringify(w.config),
      contentEditors: w.contentEditors === 'admins' ? pf.WidgetEditors.ADMINS : pf.WidgetEditors.UNSPECIFIED,
      workshopId: w.workshop?.id ?? '', workshopVersion: w.workshop?.version ?? '', packageSha256: w.workshop?.sha256 ?? '',
      snapshotMediaId: BigInt(w.snapshotMediaId || 0),
    })),
  };
}

function toProfile(v: pf.ProfileView): ProfileData {
  const st = v.stats;
  return {
    layout: toLayout(v.layout), canEditLayout: v.canEditLayout, editable: v.editableWidgetIds, canSetEditors: v.canSetWidgetEditors,
    stats: {
      messages: Number(st?.messages ?? 0n), streakDays: st?.streakDays ?? 0, joinedAt: Number(st?.joinedAt ?? 0n),
      members: st?.members ?? 0, channels: st?.channels ?? 0, createdAt: Number(st?.createdAt ?? 0n),
    },
    user: v.user ? toUser(v.user) : undefined,
  };
}

/** The server's profile page (GET /api/v1/server/profile). */
export interface ServerProfileView {
  name: string;
  description: string;
  icon: string;
  members: number;
  online: number;
  /** Who may rearrange the profile's widgets. */
  layoutEditors: 'admins' | 'everyone';
  /** Members may change widget contents (not their kind or place). */
  widgetContentEditable: boolean;
}

const INITIAL_PAGE = 50;

// ---------- conversions ----------

const ROLE: Record<number, MemberRole> = {
  [common.MemberRole.OWNER]: 'owner',
  [common.MemberRole.ADMIN]: 'admin',
};
const role = (r: common.MemberRole): MemberRole => ROLE[r] ?? 'member';
const s = (v: bigint) => (v === 0n ? '' : v.toString());

export function toUser(u: common.User): User {
  return {
    id: s(u.id),
    username: u.username,
    name: u.displayName || u.username,
    type: u.accountType === common.AccountType.AI ? 'ai' : u.accountType === common.AccountType.BOT ? 'bot' : 'human',
    ownerId: s(u.ownerId) || undefined,
    ownerName: u.ownerDisplayName || undefined,
    avatar: u.avatar || undefined,
    avatarStatic: u.avatarStatic || u.avatar || undefined,
    bio: u.bio,
  };
}

const ACTIVITY: Record<number, ActivityKind> = {
  [common.ActivityKind.LISTENING]: 'listening',
  [common.ActivityKind.PLAYING]: 'playing',
  [common.ActivityKind.TUNING_AI]: 'tuning_ai',
  [common.ActivityKind.WORKING]: 'working',
  [common.ActivityKind.CUSTOM]: 'custom',
};
const ACTIVITY_CODE = Object.fromEntries(Object.entries(ACTIVITY).map(([k, v]) => [v, Number(k)])) as Record<ActivityKind, common.ActivityKind>;

function toPresence(p: common.Presence): Presence {
  const kind = p.activity ? ACTIVITY[p.activity.kind] : undefined;
  return {
    invisible: p.invisible || undefined,
    activity: kind ? { kind, text: p.activity!.text } : undefined,
  };
}

function toBody(e: ev.Event): MessageBody | null {
  if (e.redaction) return { kind: 'deleted', byId: s(e.redaction.deletedBy), reason: e.redaction.reason };
  const b = e.body;
  const op = (v: bigint) => s(v) || s(e.senderId);
  switch (b.case) {
    case 'text':
      return { kind: 'text', text: b.value.text, replyTo: s(b.value.replyTo) || undefined };
    case 'image':
      return { kind: 'image', mediaId: s(b.value.mediaId), w: b.value.width, h: b.value.height };
    case 'file':
      return { kind: 'file', mediaId: s(b.value.mediaId), name: b.value.name, size: Number(b.value.size) };
    case 'sysConv': {
      const c = b.value;
      const o = op(c.operatorId);
      let sys: SysEvent;
      if (c.created) sys = { t: 'created', op: o };
      else if (c.dissolved) sys = { t: 'dissolved', op: o };
      else if (c.name !== undefined) sys = { t: 'name', op: o, name: c.name };
      else if (c.notice !== undefined) sys = { t: 'notice', op: o };
      else if (c.avatar !== undefined) sys = { t: 'avatar', op: o };
      else if (c.joinApproval !== undefined) sys = { t: 'approval', op: o, on: c.joinApproval };
      else return null;
      return { kind: 'system', sys };
    }
    case 'sysMember': {
      const m = b.value;
      const o = op(m.operatorId);
      const t = s(m.targetUserId);
      const A = ev.SysMember_Action;
      const map: Partial<Record<ev.SysMember_Action, SysEvent>> = {
        [A.JOIN]: { t: 'join', op: o, target: t },
        [A.LEAVE]: { t: 'leave', target: t },
        [A.KICK]: { t: 'kick', op: o, target: t },
        [A.MUTE]: { t: 'mute', op: o, target: t, until: Number(m.until) },
        [A.UNMUTE]: { t: 'unmute', op: o, target: t },
        [A.ROLE_CHANGE]: { t: 'role', op: o, target: t, role: role(m.newRole) },
      };
      const sys = map[m.action];
      return sys ? { kind: 'system', sys } : null;
    }
    default:
      return null; // strike / admin_delete change other messages; not shown
  }
}

/** Text for a system event, with the current names. */
export function systemText(sys: SysEvent, name: (id: string) => string): string {
  switch (sys.t) {
    case 'created': return `${name(sys.op)} 创建了频道`;
    case 'name': return `${name(sys.op)} 把频道名改为「${sys.name}」`;
    case 'notice': return `${name(sys.op)} 修改了频道公告`;
    case 'avatar': return `${name(sys.op)} 更换了频道头像`;
    case 'approval': return `${name(sys.op)} ${sys.on ? '开启' : '关闭'}了加入审批`;
    case 'dissolved': return `${name(sys.op)} 解散了频道`;
    case 'join': return sys.op === sys.target ? `${name(sys.target)} 加入了频道` : `${name(sys.op)} 邀请 ${name(sys.target)} 加入了频道`;
    case 'leave': return `${name(sys.target)} 退出了频道`;
    case 'kick': return `${name(sys.op)} 把 ${name(sys.target)} 移出了频道`;
    case 'mute': {
      const d = new Date(sys.until);
      return `${name(sys.op)} 禁言了 ${name(sys.target)}，到 ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    case 'unmute': return `${name(sys.op)} 解除了 ${name(sys.target)} 的禁言`;
    case 'role':
      if (sys.role === 'owner') return `${name(sys.target)} 成为了频道主`;
      if (sys.role === 'admin') return `${name(sys.op)} 把 ${name(sys.target)} 设为了管理员`;
      return `${name(sys.target)} 现在是普通成员`;
  }
}

export function previewText(m: Message, name: (id: string) => string): string {
  const b = m.body;
  switch (b.kind) {
    case 'text': return b.text;
    case 'image': return '[图片]';
    case 'file': return `[文件] ${b.name}`;
    case 'deleted': return '[消息已被删除]';
    case 'system': return systemText(b.sys, name);
  }
}

function randomId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---------- session ----------

export class Session {
  readonly t: Transport;
  private socket: Socket | null = null;
  private reqId = 0n;
  private pending = new Map<bigint, { resolve: (f: gw.ServerFrame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private emitQueued = false;
  /** Strikes / deletions for messages not loaded yet. */
  private struckIds = new Set<string>();
  view: SessionView;
  /**
   * Called after I change my own profile, presence or profile board here
   * (lib/sync.ts copies the change to my other servers). Writes made by the
   * sync itself pass quiet = true.
   */
  onOwnChange?: (parts: SyncPart[]) => void;
  /** Another device of mine saved my server list (lib/devices.ts loads it again). */
  onClientState?: () => void;

  constructor(
    public record: ServerRecord,
    private onChange: (v: SessionView) => void,
    private onRecord: (r: ServerRecord) => void,
    private onMessage?: (convId: string, m: Message) => void,
  ) {
    this.t = createTransport(record.id, record.endpoint);
    this.view = {
      id: record.id, name: record.name, status: record.token ? 'connecting' : 'logged_out',
      users: {}, convs: {}, messages: {}, hasOlder: {}, isAdmin: false, blocked: [], joinRequests: {}, downloadUrl: '',
      presence: {},
      icon: '',
    };
  }

  // ---- state helpers ----

  private emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.view = { ...this.view };
      this.onChange(this.view);
    });
  }

  private patch(p: Partial<SessionView>) {
    this.view = { ...this.view, ...p };
    this.emit();
  }

  private addUsers(list: common.User[]) {
    if (!list.length) return;
    const users = { ...this.view.users };
    for (const u of list) {
      const v = toUser(u);
      users[v.id] = { ...users[v.id], ...v };
    }
    this.view.users = users;
  }

  nameOf = (id: string) => this.view.users[id]?.name ?? (id === this.view.me?.id ? this.view.me.name : '某人');

  // ---- HTTP ----

  async call<O extends DescMessage>(method: string, path: string, resp: O | null, req?: { schema: DescMessage; value: object }): Promise<MessageShape<O>> {
    const body = req ? toJsonString(req.schema, create(req.schema, req.value as MessageInitShape<DescMessage>)) : undefined;
    const r = await this.t.api(method, path, body);
    if (r.status >= 400) {
      const err = errorFromBody(r.status, r.body);
      if (err.code === 'unauthorized' || err.code === 'banned') this.loggedOut(err.message);
      throw err;
    }
    return (resp ? fromJsonString(resp, r.body, { ignoreUnknownFields: true }) : undefined) as MessageShape<O>;
  }

  // ---- account ----

  async register(invite: string, username: string, password: string, displayName: string) {
    const r = await this.call('POST', '/api/v1/register', api.SessionResponseSchema, {
      schema: api.RegisterRequestSchema, value: { inviteCode: invite, username, password, displayName, deviceName: deviceName() },
    });
    await this.loggedIn(r.token, r.me!);
  }

  /** invite: only used when the account left this server (coming back costs a new invite code). */
  async login(username: string, password: string, invite = '') {
    const r = await this.call('POST', '/api/v1/login', api.SessionResponseSchema, {
      schema: api.LoginRequestSchema, value: { username, password, deviceName: deviceName(), inviteCode: invite },
    });
    await this.loggedIn(r.token, r.me!);
  }

  private async loggedIn(token: string, me: common.User) {
    this.record = { ...this.record, token, userId: s(me.id) };
    this.onRecord(this.record);
    this.view.me = toUser(me);
    await this.start();
  }

  private loggedOut(reason: string) {
    this.stop();
    this.record = { ...this.record, token: undefined };
    this.onRecord(this.record);
    this.patch({ status: 'logged_out', error: reason });
  }

  /** Logs out here; the server frees this device's place (limits.max_devices). */
  async logout() {
    if (this.record.token) await this.call('POST', '/api/v1/logout', null).catch(() => {});
    this.loggedOut('');
  }

  // ---- several devices (lib/devices.ts) ----

  /** One-time ticket that logs in another device of mine; bundle goes along to it. */
  async createPairTicket(bundle?: Uint8Array) {
    const r = await this.call('POST', '/api/v1/pair', api.PairTicketSchema, {
      schema: api.CreatePairTicketRequestSchema, value: { bundle: bundle ?? new Uint8Array() },
    });
    return { ticket: r.ticket, expiresAt: Number(r.expiresAt) };
  }

  /** Logs this device in with a pairing ticket; returns the bundle that came with it. */
  async redeemPair(ticket: string): Promise<Uint8Array> {
    const r = await this.call('POST', '/api/v1/pair/redeem', api.PairRedeemResponseSchema, {
      schema: api.RedeemPairTicketRequestSchema, value: { ticket, deviceName: deviceName() },
    });
    await this.loggedIn(r.token, r.me!);
    return r.bundle;
  }

  /** The encrypted state my devices share (my server list). */
  async clientState() {
    const r = await this.call('GET', '/api/v1/me/client-state', api.ClientStateSchema);
    return { data: r.data, updatedAt: Number(r.updatedAt) };
  }

  async putClientState(data: Uint8Array, base: number) {
    const r = await this.call('PUT', '/api/v1/me/client-state', api.ClientStateSchema, {
      schema: api.PutClientStateRequestSchema, value: { data, baseUpdatedAt: BigInt(base) },
    });
    return Number(r.updatedAt);
  }

  /**
   * Leaves the server for good: logged out everywhere, out of every channel,
   * hidden from the member list. Coming back needs a new invite code.
   */
  async leaveServer() {
    await this.call('POST', '/api/v1/me/leave', null);
    this.stop();
  }

  async serverProfile(): Promise<ServerProfileView> {
    const p = await this.call('GET', '/api/v1/server/profile', api.ServerProfileSchema);
    if (p.icon !== this.view.icon || p.name !== this.view.name) this.patch({ icon: p.icon, name: p.name || this.view.name });
    return {
      name: p.name, description: p.description, icon: p.icon, members: p.memberCount, online: p.onlineCount,
      layoutEditors: p.layoutEditors === api.ProfileEditors.EVERYONE ? 'everyone' : 'admins',
      widgetContentEditable: p.widgetContentEditable,
    };
  }

  // ---- connection ----

  async start() {
    if (!this.record.token) return;
    this.stopped = false;
    await this.t.setToken(this.record.token);
    this.call('GET', '/api/v1/server', api.ServerInfoSchema).then((i) => {
      if (i.name && i.name !== this.record.name) {
        this.record = { ...this.record, name: i.name };
        this.onRecord(this.record);
      }
      this.patch({ name: i.name || this.view.name, downloadUrl: i.downloadUrl, icon: i.icon });
    }).catch(() => {});
    await this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }

  private async connect() {
    this.patch({ status: 'connecting' });
    try {
      this.socket = await this.t.openSocket((d) => this.onFrame(d), (reason) => this.onClose(reason));
    } catch (e) {
      this.patch({ status: 'offline', error: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
      return;
    }
    try {
      const f = await this.request({ case: 'auth', value: create(gw.AuthRequestSchema, { token: this.record.token! }) });
      if (f.msg.case !== 'auth') throw new Error('unexpected reply');
      this.retry = 0;
      await this.onAuth(f.msg.value);
      this.patch({ status: 'online', error: undefined });
      this.loadBlocks().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'unauthorized' || e.code === 'banned')) this.loggedOut(e.message);
      else this.socket?.close();
    }
  }

  private onClose(reason: string) {
    this.socket = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('连接断开了'));
    }
    this.pending.clear();
    this.patch({ presence: {} });
    if (this.stopped || this.view.status === 'logged_out') return;
    this.patch({ status: 'offline', error: reason === 'closed' ? undefined : reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Reconnect right away (e.g. the user clicked "重试"). */
  reconnectNow() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    if (!this.socket) this.connect();
  }

  private request(msg: gw.ClientFrame['msg'], timeout = 15_000): Promise<gw.ServerFrame> {
    const sock = this.socket;
    if (!sock) return Promise.reject(new Error('还没连上服务器'));
    const id = ++this.reqId;
    const frame = create(gw.ClientFrameSchema, { reqId: id, msg });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('服务器没有响应'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(toBinary(gw.ClientFrameSchema, frame));
    });
  }

  private onFrame(data: Uint8Array) {
    let f: gw.ServerFrame;
    try {
      f = fromBinary(gw.ServerFrameSchema, data);
    } catch {
      return;
    }
    if (f.reqId !== 0n) {
      const p = this.pending.get(f.reqId);
      if (!p) return;
      this.pending.delete(f.reqId);
      clearTimeout(p.timer);
      if (f.msg.case === 'error') p.reject(new ApiError(f.msg.value.code, f.msg.value.message));
      else p.resolve(f);
      return;
    }
    switch (f.msg.case) {
      case 'error':
        if (f.msg.value.code === 'unauthorized' || f.msg.value.code === 'banned') this.loggedOut(new ApiError(f.msg.value.code).message);
        break;
      case 'event':
        if (f.msg.value.event) this.applyEvents([f.msg.value.event], true);
        break;
      case 'conv':
        if (f.msg.value.conversation) this.upsertConv(f.msg.value.conversation);
        break;
      case 'convRemoved': {
        const id = s(f.msg.value.convId);
        const R = gw.ConvRemovedPush_Reason;
        const left = f.msg.value.reason === R.KICKED ? 'kicked' : f.msg.value.reason === R.DISSOLVED ? 'dissolved' : 'left';
        const c = this.view.convs[id];
        if (c) this.view.convs = { ...this.view.convs, [id]: { ...c, left } };
        this.emit();
        break;
      }
      case 'presence': {
        const p = f.msg.value.presence;
        if (!p) break;
        const id = s(p.userId);
        const presence = { ...this.view.presence };
        if (p.online) presence[id] = toPresence(p);
        else delete presence[id];
        this.patch({ presence });
        break;
      }
      case 'clientState':
        this.onClientState?.();
        break;
      case 'joinRequest': {
        const jr = f.msg.value;
        const id = s(jr.convId);
        const list = this.view.joinRequests[id] ?? [];
        const item: JoinRequest = { user: toUser(jr.user!), inviter: toUser(jr.inviter!), time: Date.now() };
        this.view.joinRequests = { ...this.view.joinRequests, [id]: [...list.filter((x) => x.user.id !== item.user.id), item] };
        this.emit();
        break;
      }
    }
  }

  // ---- conversations & events ----

  private convFrom(c: common.Conversation, prev?: Conversation): Conversation {
    this.addUsers(c.members);
    const members = c.members.map((u, i) => ({ userId: s(u.id), role: role(c.memberRoles[i] ?? common.MemberRole.MEMBER) }));
    const me = this.view.me?.id;
    const peer = c.kind === common.ConvKind.DM ? members.find((m) => m.userId !== me)?.userId : undefined;
    return {
      id: s(c.id),
      kind: c.kind === common.ConvKind.GROUP ? 'group' : 'dm',
      name: c.name || (peer ? this.nameOf(peer) : '会话'),
      avatar: c.avatar || undefined,
      ownerId: s(c.ownerId) || undefined,
      peerId: peer,
      members,
      notice: c.notice,
      joinApproval: c.joinApproval,
      public: c.public,
      lastSeq: Number(c.lastSeq),
      readSeq: Math.max(Number(c.self?.readSeq ?? 0n), prev?.readSeq ?? 0),
      myRole: role(c.self?.role ?? common.MemberRole.MEMBER),
      mutedUntil: Number(c.self?.mutedUntil ?? 0n),
      lastText: prev?.lastText ?? '',
      lastTime: prev?.lastTime ?? 0,
      left: undefined,
    };
  }

  private upsertConv(c: common.Conversation) {
    const id = s(c.id);
    const fresh = !this.view.convs[id];
    this.view.convs = { ...this.view.convs, [id]: this.convFrom(c, this.view.convs[id]) };
    this.emit();
    if (fresh) this.syncConvs([{ id, after: 0 }]).catch(() => {});
  }

  private async onAuth(a: gw.AuthResponse) {
    if (a.me) {
      this.addUsers([a.me]);
      this.view.me = toUser(a.me);
    }
    this.view.isAdmin = a.isSiteAdmin;
    this.view.presence = Object.fromEntries(a.presences.filter((p) => p.online).map((p) => [s(p.userId), toPresence(p)]));
    const convs: Record<string, Conversation> = {};
    for (const c of a.conversations) {
      const id = s(c.id);
      convs[id] = this.convFrom(c, this.view.convs[id]);
    }
    this.view.convs = convs;
    this.emit();
    // Fill gaps: from our newest message, or the last page for new conversations.
    const cursors: { id: string; after: number }[] = [];
    const hasOlder: Record<string, boolean> = { ...this.view.hasOlder };
    for (const c of Object.values(convs)) {
      const local = this.view.messages[c.id];
      const newest = local?.filter((m) => !m.pending).at(-1)?.seq ?? 0;
      if (newest >= c.lastSeq) continue;
      const after = newest > 0 ? newest : Math.max(0, c.lastSeq - INITIAL_PAGE);
      if (!newest) hasOlder[c.id] = after > 0;
      cursors.push({ id: c.id, after });
    }
    this.view.hasOlder = hasOlder;
    await this.syncConvs(cursors);
  }

  private async syncConvs(cursors: { id: string; after: number }[]) {
    while (cursors.length) {
      const f = await this.request({
        case: 'sync',
        value: create(gw.SyncRequestSchema, { cursors: cursors.map((c) => ({ convId: BigInt(c.id), afterSeq: BigInt(c.after) })), limit: 200 }),
      });
      if (f.msg.case !== 'sync') return;
      const r = f.msg.value;
      this.applyEvents(r.events, false);
      const more = new Set(r.hasMore.map(s));
      cursors = cursors
        .filter((c) => more.has(c.id))
        .map((c) => ({ id: c.id, after: this.view.messages[c.id]?.filter((m) => !m.pending).at(-1)?.seq ?? c.after }));
    }
  }

  /** Loads one more page of older messages. */
  async loadOlder(convId: string) {
    const list = this.view.messages[convId] ?? [];
    const first = list.find((m) => !m.pending)?.seq ?? (this.view.convs[convId]?.lastSeq ?? 0) + 1;
    if (first <= 1) {
      this.view.hasOlder = { ...this.view.hasOlder, [convId]: false };
      this.emit();
      return;
    }
    const after = Math.max(0, first - 1 - INITIAL_PAGE);
    const f = await this.request({
      case: 'sync',
      value: create(gw.SyncRequestSchema, { cursors: [{ convId: BigInt(convId), afterSeq: BigInt(after) }], limit: first - 1 - after }),
    });
    if (f.msg.case === 'sync') this.applyEvents(f.msg.value.events.filter((e) => Number(e.seq) < first), false);
    this.view.hasOlder = { ...this.view.hasOlder, [convId]: after > 0 };
    this.emit();
  }

  private applyEvents(events: ev.Event[], live: boolean) {
    if (!events.length) return;
    const touched = new Map<string, Message[]>();
    const get = (id: string) => {
      let l = touched.get(id);
      if (!l) {
        l = [...(this.view.messages[id] ?? [])];
        touched.set(id, l);
      }
      return l;
    };
    const unknown = new Set<string>();
    for (const e of events) {
      const convId = s(e.convId);
      const list = get(convId);
      const seq = Number(e.seq);
      // Strike / admin delete modify their target.
      if (e.body.case === 'strike' || e.body.case === 'adminDelete') {
        const target = s(e.body.value.targetEventId);
        const i = list.findIndex((m) => m.id === target);
        if (e.body.case === 'strike') {
          if (i >= 0) list[i] = { ...list[i], struck: true };
          else this.struckIds.add(target);
        } else if (i >= 0) {
          list[i] = { ...list[i], body: { kind: 'deleted', byId: s(e.senderId), reason: e.body.value.reason } };
        }
      }
      const body = toBody(e);
      if (body) {
        const id = s(e.eventId);
        const msg: Message = {
          id, seq, senderId: s(e.senderId), time: Number(e.createdAt), body,
          struck: this.struckIds.delete(id) || undefined, clientMsgId: e.clientMsgId || undefined,
        };
        // Replace our own pending copy, or skip duplicates.
        const pendingIdx = msg.clientMsgId ? list.findIndex((m) => m.pending && m.clientMsgId === msg.clientMsgId) : -1;
        if (pendingIdx >= 0) list.splice(pendingIdx, 1);
        if (!list.some((m) => m.id === id)) {
          // Insert in seq order (pending messages stay last).
          let at = list.length;
          while (at > 0 && (list[at - 1].pending || list[at - 1].seq > seq)) at--;
          list.splice(at, 0, msg);
          if (!this.view.users[msg.senderId] && msg.senderId) unknown.add(msg.senderId);
          if (live && msg.senderId !== this.view.me?.id) this.onMessage?.(convId, msg);
        }
      }
      // Conversation summary.
      const c = this.view.convs[convId];
      if (c) {
        const nc = { ...c, lastSeq: Math.max(c.lastSeq, seq) };
        if (body && seq >= c.lastSeq) {
          nc.lastText = previewText({ id: '', seq, senderId: s(e.senderId), time: 0, body }, this.nameOf);
          if (body.kind !== 'system' && c.kind === 'group') nc.lastText = `${this.nameOf(s(e.senderId))}：${nc.lastText}`;
          nc.lastTime = Number(e.createdAt);
        }
        if (s(e.senderId) === this.view.me?.id && body?.kind !== 'system') nc.readSeq = Math.max(nc.readSeq, seq);
        this.view.convs = { ...this.view.convs, [convId]: nc };
      }
    }
    const messages = { ...this.view.messages };
    for (const [id, l] of touched) messages[id] = l;
    this.view.messages = messages;
    this.emit();
    for (const id of unknown) this.fetchUser(id);
  }

  private async fetchUser(id: string) {
    try {
      const u = await this.call('GET', `/api/v1/users/${id}`, common.UserSchema);
      this.addUsers([u]);
      this.emit();
    } catch {
      /* deleted user: keep "某人" */
    }
  }

  // ---- sending ----

  private async sendBody(convId: string, body: gw.SendRequest['body'], local: MessageBody) {
    const clientMsgId = randomId();
    const tmp: Message = {
      id: 'local-' + clientMsgId, seq: Number.MAX_SAFE_INTEGER, senderId: this.view.me!.id, time: Date.now(),
      body: local, clientMsgId, pending: true,
    };
    this.view.messages = { ...this.view.messages, [convId]: [...(this.view.messages[convId] ?? []), tmp] };
    this.emit();
    try {
      const f = await this.request({ case: 'send', value: create(gw.SendRequestSchema, { convId: BigInt(convId), clientMsgId, body }) });
      if (f.msg.case === 'send' && f.msg.value.event) this.applyEvents([f.msg.value.event], false);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      this.view.messages = {
        ...this.view.messages,
        [convId]: (this.view.messages[convId] ?? []).map((m) => (m.clientMsgId === clientMsgId && m.pending ? { ...m, failed: err } : m)),
      };
      this.emit();
      throw e;
    }
  }

  sendText(convId: string, text: string) {
    return this.sendBody(convId, { case: 'text', value: create(ev.TextMsgSchema, { text }) }, { kind: 'text', text });
  }

  /** Removes a failed message from the list (it was never sent). */
  dropFailed(convId: string, msgId: string) {
    this.view.messages = { ...this.view.messages, [convId]: (this.view.messages[convId] ?? []).filter((m) => m.id !== msgId) };
    this.emit();
  }

  async upload(file: File) {
    const r = await this.t.upload(file);
    if (r.status >= 400) throw errorFromBody(r.status, r.body);
    return fromJsonString(api.MediaInfoSchema, r.body, { ignoreUnknownFields: true });
  }

  async sendFile(convId: string, file: File) {
    const info = await this.upload(file);
    if (info.isImage) {
      return this.sendBody(convId, { case: 'image', value: create(ev.ImageMsgSchema, { mediaId: info.id }) },
        { kind: 'image', mediaId: s(info.id), w: info.width, h: info.height });
    }
    return this.sendBody(convId, { case: 'file', value: create(ev.FileMsgSchema, { mediaId: info.id, name: file.name }) },
      { kind: 'file', mediaId: s(info.id), name: file.name, size: Number(info.size) });
  }

  async strike(convId: string, eventId: string) {
    await this.request({ case: 'send', value: create(gw.SendRequestSchema, { convId: BigInt(convId), clientMsgId: randomId(), body: { case: 'strike', value: create(ev.StrikeActSchema, { targetEventId: BigInt(eventId) }) } }) })
      .then((f) => f.msg.case === 'send' && f.msg.value.event && this.applyEvents([f.msg.value.event], false));
  }

  async adminDelete(eventId: string, reason: string, blockMedia = false) {
    await this.call('POST', `/api/v1/events/${eventId}/delete`, null, { schema: api.AdminDeleteRequestSchema, value: { reason, blockMedia } });
  }

  markRead(convId: string) {
    const c = this.view.convs[convId];
    if (!c || c.readSeq >= c.lastSeq || !this.socket) return;
    this.view.convs = { ...this.view.convs, [convId]: { ...c, readSeq: c.lastSeq } };
    this.emit();
    this.request({ case: 'markRead', value: create(gw.MarkReadRequestSchema, { convId: BigInt(convId), seq: BigInt(c.lastSeq) }) }).catch(() => {});
  }

  // ---- people (no friends: anyone on the server can be messaged) ----

  /** One page of the server's member directory. */
  async listUsers(query = '', after = '') {
    const qs = new URLSearchParams({ limit: '50' });
    if (query) qs.set('query', query);
    if (after) qs.set('after', after);
    const r = await this.call('GET', `/api/v1/users?${qs}`, api.ListUsersResponseSchema);
    this.addUsers(r.users);
    this.emit();
    return { users: r.users.map(toUser), nextAfter: s(r.nextAfter) };
  }

  async loadBlocks() {
    const r = await this.call('GET', '/api/v1/blocks', api.ListBlocksResponseSchema);
    this.addUsers(r.users);
    this.patch({ blocked: r.users.map((u) => s(u.id)) });
  }

  async setBlocked(userId: string, on: boolean) {
    await this.call(on ? 'POST' : 'DELETE', `/api/v1/blocks/${userId}`, null);
    this.patch({ blocked: on ? [userId, ...this.view.blocked.filter((x) => x !== userId)] : this.view.blocked.filter((x) => x !== userId) });
  }

  async openDM(userId: string) {
    const c = await this.call('POST', '/api/v1/dm', common.ConversationSchema, { schema: api.OpenDMRequestSchema, value: { userId: BigInt(userId) } });
    this.upsertConv(c);
    return s(c.id);
  }

  // ---- channels (protocol name: groups) ----

  /** Creates a channel: private with the given members, or public (site admins; everyone joins). */
  async createGroup(name: string, memberIds: string[], isPublic = false) {
    const c = await this.call('POST', '/api/v1/groups', common.ConversationSchema, {
      schema: api.CreateGroupRequestSchema, value: { name, memberIds: memberIds.map(BigInt), public: isPublic },
    });
    this.upsertConv(c);
    return s(c.id);
  }

  /** All public channels ("browse channels"). */
  async listChannels(): Promise<ChannelInfo[]> {
    const r = await this.call('GET', '/api/v1/channels', api.ListChannelsResponseSchema);
    return r.channels.map((c) => ({
      id: s(c.id), name: c.name, avatar: c.avatar || undefined, notice: c.notice, memberCount: c.memberCount, joined: c.joined,
    }));
  }

  async joinChannel(convId: string) {
    this.upsertConv(await this.call('POST', `/api/v1/channels/${convId}/join`, common.ConversationSchema));
    return convId;
  }

  async refreshConv(convId: string) {
    this.upsertConv(await this.call('GET', `/api/v1/conversations/${convId}`, common.ConversationSchema));
  }

  async inviteMembers(convId: string, userIds: string[]) {
    return this.call('POST', `/api/v1/groups/${convId}/members`, api.InviteMembersResponseSchema, {
      schema: api.InviteMembersRequestSchema, value: { userIds: userIds.map(BigInt) },
    });
  }

  async updateGroup(convId: string, value: { name?: string; notice?: string; joinApproval?: boolean; avatarMediaId?: bigint }) {
    this.upsertConv(await this.call('PATCH', `/api/v1/groups/${convId}`, common.ConversationSchema, { schema: api.UpdateGroupRequestSchema, value }));
  }

  removeMember(convId: string, userId: string) {
    return this.call('DELETE', `/api/v1/groups/${convId}/members/${userId}`, null);
  }

  setAdmin(convId: string, userId: string, on: boolean) {
    return this.call(on ? 'POST' : 'DELETE', `/api/v1/groups/${convId}/admins/${userId}`, null);
  }

  transfer(convId: string, userId: string) {
    return this.call('POST', `/api/v1/groups/${convId}/transfer`, null, { schema: api.TransferGroupRequestSchema, value: { userId: BigInt(userId) } });
  }

  mute(convId: string, userId: string, seconds: number) {
    return this.call('POST', `/api/v1/groups/${convId}/mute`, null, {
      schema: api.MuteMemberRequestSchema, value: { userId: BigInt(userId), durationSeconds: BigInt(seconds) },
    });
  }

  dissolve(convId: string) {
    return this.call('DELETE', `/api/v1/groups/${convId}`, null);
  }

  async loadJoinRequests(convId: string) {
    const r = await this.call('GET', `/api/v1/groups/${convId}/requests`, api.ListJoinRequestsResponseSchema);
    this.view.joinRequests = {
      ...this.view.joinRequests,
      [convId]: r.requests.map((x) => ({ user: toUser(x.user!), inviter: toUser(x.inviter!), time: Number(x.createdAt) })),
    };
    this.emit();
  }

  async decideJoin(convId: string, userId: string, approve: boolean) {
    await this.call('POST', `/api/v1/groups/${convId}/requests/${userId}/${approve ? 'approve' : 'reject'}`, null);
    this.view.joinRequests = { ...this.view.joinRequests, [convId]: (this.view.joinRequests[convId] ?? []).filter((x) => x.user.id !== userId) };
    this.emit();
  }

  // ---- me ----

  async updateProfile(value: { displayName?: string; avatarMediaId?: bigint; bio?: string }, quiet = false) {
    const u = await this.call('PATCH', '/api/v1/me', common.UserSchema, { schema: api.UpdateProfileRequestSchema, value });
    this.addUsers([u]);
    this.view.me = toUser(u);
    this.emit();
    if (!quiet) this.onOwnChange?.(['profile']);
  }

  /** Invisible mode and activity. Saved on the server (stays after restarting). */
  async setPresence(invisible: boolean, activity?: Activity, quiet = false) {
    const p = await this.call('PUT', '/api/v1/me/presence', common.PresenceSchema, {
      schema: api.SetPresenceRequestSchema,
      value: { invisible, activity: activity ? { kind: ACTIVITY_CODE[activity.kind], text: activity.text } : undefined },
    });
    const me = this.view.me?.id;
    if (me && this.view.status === 'online') this.patch({ presence: { ...this.view.presence, [me]: toPresence(p) } });
    if (!quiet) this.onOwnChange?.(['presence']);
  }

  // ---- profile pages (widgets) ----

  async getProfile(t: ProfileTarget): Promise<ProfileData> {
    const v = toProfile(await this.call('GET', profilePath(t), pf.ProfileViewSchema));
    if (v.user) {
      this.view.users = { ...this.view.users, [v.user.id]: { ...this.view.users[v.user.id], ...v.user } };
      this.emit();
    }
    return v;
  }

  /** Saves a new version; `layout.version` is the version the edit started from. */
  async saveProfile(t: ProfileTarget, layout: LayoutModel, quiet = false): Promise<ProfileData> {
    const v = toProfile(await this.call('PUT', profilePath(t), pf.ProfileViewSchema, {
      schema: pf.SaveProfileRequestSchema, value: { layout: fromLayout(layout), baseVersion: BigInt(layout.version) },
    }));
    if (!quiet && t === this.view.me?.id) this.onOwnChange?.(['board']);
    return v;
  }

  async guestbook(t: ProfileTarget, widgetId: string, before = ''): Promise<{ entries: GuestEntry[]; nextBefore: string; canHide: boolean }> {
    const r = await this.call('GET', `${profilePath(t)}/guestbook/${widgetId}?before=${before || 0}`, pf.ListGuestbookResponseSchema);
    return {
      entries: r.entries.map((e) => ({ id: s(e.id), author: e.author ? toUser(e.author) : undefined, text: e.text, time: Number(e.createdAt), hidden: e.hidden })),
      nextBefore: s(r.nextBefore), canHide: r.canHide,
    };
  }

  async postGuestbook(t: ProfileTarget, widgetId: string, text: string): Promise<GuestEntry> {
    const e = await this.call('POST', `${profilePath(t)}/guestbook/${widgetId}`, pf.GuestbookEntrySchema, { schema: pf.PostGuestbookRequestSchema, value: { text } });
    return { id: s(e.id), author: e.author ? toUser(e.author) : undefined, text: e.text, time: Number(e.createdAt), hidden: e.hidden };
  }

  hideGuestbook(id: string, hidden: boolean) {
    return this.call('POST', `/api/v1/guestbook/${id}/hide`, null, { schema: pf.HideGuestbookRequestSchema, value: { hidden } });
  }

  deleteGuestbook(id: string, reason: string) {
    return this.call('POST', `/api/v1/guestbook/${id}/delete`, null, { schema: pf.DeleteGuestbookRequestSchema, value: { reason } });
  }

  async invites(): Promise<{ list: Invite[]; remaining: number }> {
    const r = await this.call('GET', '/api/v1/invites', api.ListInvitesResponseSchema);
    const pin = this.record.endpoint.pin;
    const join = { address: this.record.endpoint.address, plain: this.record.endpoint.plain, pin: pin ? new Uint8Array(pin.match(/../g)!.map((h) => parseInt(h, 16))) : undefined };
    const list: Invite[] = [];
    for (const i of r.invites) {
      let joinCode = i.joinCode;
      let url = i.joinUrl;
      if (!joinCode && !i.usedBy) {
        // The server has no public address set: build the code from the
        // address this client uses.
        joinCode = await encodeJoinCode({ ...join, invite: i.code });
        url = joinUrl(this.view.downloadUrl, joinCode);
      }
      list.push({ code: i.code, joinCode, joinUrl: url, usedBy: i.usedBy ? i.usedByName || '某人' : undefined });
    }
    return { list, remaining: r.remaining };
  }

  async createInvite() {
    await this.call('POST', '/api/v1/invites', api.InviteSchema);
  }

  /** Devices I am logged in on, and the most allowed (0 = no limit). */
  async sessions() {
    const r = await this.call('GET', '/api/v1/sessions', api.ListSessionsResponseSchema);
    return { list: r.sessions, max: r.maxDevices };
  }

  revokeSession(id: bigint) {
    return this.call('DELETE', `/api/v1/sessions/${id}`, null);
  }

  async logins() {
    return (await this.call('GET', '/api/v1/me/logins', api.ListLoginRecordsResponseSchema)).records;
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '设备';
  return `AM ${os}`;
}
