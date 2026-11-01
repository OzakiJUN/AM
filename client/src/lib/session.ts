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
import { parseGame, type Game, type GameKind } from './games';
import type { Background, LayoutModel, WidgetModel } from './widgets';
import type { Activity, ActivityKind, ChannelInfo, Conversation, Invite, JoinRequest, MemberRole, Message, MessageBody, Presence, SysEvent, User } from './types';

/** One of my AI accounts; settings is its JSON (lib/ai/persona.ts parses it). */
export interface AIInfo {
  user: User;
  settings: string;
  updatedAt: number;
  /** People waiting for me to let them talk with it. */
  shareRequests: number;
}

export interface ServerRecord {
  id: string;
  endpoint: Endpoint;
  /** Addresses this server had before (newest first): tried when the current one stops working. */
  oldAddresses?: string[];
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
  /** AI plugins (NoneBot) can be uploaded on this server. */
  plugins: boolean;
  /** Who is online, as I see them (user id -> presence). Empty while disconnected. */
  presence: Record<string, Presence>;
  /** Server icon (media path), '' when none. */
  icon: string;
  /** Board games in my conversations that I have seen (id -> my view of it). */
  games: Record<string, Game>;
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

export interface RemoteToolAsk {
  requestId: string;
  ai: User;
  tool: string;
  argsJson: string;
}

export interface RemoteToolAnswer {
  ok: boolean;
  text: string;
  images: string[];
}

export interface Sticker {
  id: string;
  mediaId: string;
  /** Everyone's tags for a shared one (most-added first), my own for a private one. */
  tags: string[];
  /** The tags I added (the ones I can take off). */
  myTags: string[];
  /** Entry in the server's shared library, '' = not shared. */
  libraryId: string;
  private: boolean;
  /** Who first uploaded the picture ('' for private ones). */
  uploaderId: string;
  /** SHA-256 of the picture file. */
  sha256: string;
  /** When it was added to my collection (unix ms). */
  createdAt: number;
}

/** One setting of a plugin (the form is generated from these). */
export interface PluginSetting {
  key: string;
  label: string;
  help: string;
  /** string | int | float | bool | list | path | select | text */
  type: string;
  /** The plugin's default (undefined = not known). */
  default: unknown;
  options: string[];
  group: string;
  secret: boolean;
  min?: number;
  max?: number;
}

/** A plugin of one of my AIs (docs/plugins.md). */
export interface Plugin {
  id: string;
  dir: string;
  name: string;
  description: string;
  usage: string;
  commands: string[];
  requires: string[];
  settings: PluginSetting[];
  /** Current values (secret ones left out). */
  values: Record<string, unknown>;
  /** Secret settings that have a value. */
  secretsSet: string[];
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string;
  enabled: boolean;
  uploadedAt: number;
}

export interface PluginList {
  plugins: Plugin[];
  /** The AI's plugin process: off | preparing | starting | running | error */
  state: string;
  error: string;
  log: string[];
  /** What commands start with ("" = no prefix needed). */
  commandStart: string[];
}

const parseJSON = (s: string): unknown => {
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const toPlugin = (p: api.AIPlugin): Plugin => ({
  id: p.id.toString(), dir: p.dir, name: p.name || p.dir, description: p.description, usage: p.usage,
  commands: p.commands, requires: p.requires,
  settings: p.configItems.map((c) => ({
    key: c.key, label: c.label, help: c.help, type: c.type || 'string', default: parseJSON(c.defaultJson),
    options: c.options, group: c.group, secret: c.secret, min: c.min, max: c.max,
  })),
  values: (parseJSON(p.configJson) as Record<string, unknown> | undefined) ?? {},
  secretsSet: p.secretsSet, status: (p.status || 'pending') as Plugin['status'], rejectReason: p.rejectReason,
  enabled: p.enabled, uploadedAt: Number(p.uploadedAt),
});

const toSticker = (x: api.Sticker): Sticker => ({
  id: s(x.id), mediaId: s(x.mediaId), tags: x.tags, myTags: x.myTags, libraryId: x.libraryId ? s(x.libraryId) : '',
  private: x.private, uploaderId: x.uploaderId ? s(x.uploaderId) : '', sha256: x.sha256, createdAt: Number(x.createdAt),
});

/** A picture in the server's shared sticker library (「大家的」). */
export interface LibrarySticker {
  id: string;
  mediaId: string;
  tags: string[];
  myTags: string[];
  uploaderId: string;
  collectors: number;
  /** My sticker for it, '' = not in my collection. */
  mySticker: string;
  w: number;
  h: number;
}

const toLibrary = (x: api.LibrarySticker): LibrarySticker => ({
  id: s(x.id), mediaId: s(x.mediaId), tags: x.tags, myTags: x.myTags, uploaderId: s(x.uploaderId), collectors: x.collectors,
  mySticker: x.myStickerId ? s(x.myStickerId) : '', w: x.width, h: x.height,
});

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
    gone: u.gone || undefined,
    portraitsAt: Number(u.portraitsAt) || undefined,
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
      return { kind: 'text', text: b.value.text, replyTo: s(b.value.replyTo) || undefined, mood: b.value.mood || undefined, mentions: b.value.mentions.length ? b.value.mentions.map(s) : undefined };
    case 'image':
      return { kind: 'image', mediaId: s(b.value.mediaId), w: b.value.width, h: b.value.height, stickerTags: b.value.stickerTags.length ? b.value.stickerTags : undefined };
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
const MEMBER_CHANGES = new Set<SysEvent['t']>(['join', 'leave', 'kick', 'role']);

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
    case 'image': return b.stickerTags ? '[表情]' : '[图片]';
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
  /** The server has a new public address (relay changed): lib/store.ts checks it and switches. */
  onMoved?: (address: string) => void;
  /** Someone asks me to let them talk with one of my AIs. */
  onShareRequest?: (aiId: string, user: User) => void;
  /** Someone's AI asks this device to run a computer tool (lib/ai/remote.ts decides). */
  onRemoteTool?: (r: RemoteToolAsk) => void;
  private remoteWaits = new Map<string, { from: string; done: (r: RemoteToolAnswer) => void }>();
  /** Several connection attempts failed (lib/store.ts tries the addresses used before). */
  onUnreachable?: () => void;

  constructor(
    public record: ServerRecord,
    private onChange: (v: SessionView) => void,
    private onRecord: (r: ServerRecord) => void,
    private onMessage?: (convId: string, m: Message) => void,
  ) {
    this.t = createTransport(record.id, record.endpoint);
    this.view = {
      id: record.id, name: record.name, status: record.token ? 'connecting' : 'logged_out',
      users: {}, convs: {}, messages: {}, hasOlder: {}, isAdmin: false, blocked: [], joinRequests: {}, downloadUrl: '', plugins: false,
      presence: {},
      icon: '',
      games: {},
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

  // ---- my AI accounts (lib/ai) ----

  async listAI(): Promise<AIInfo[]> {
    const r = await this.call('GET', '/api/v1/ai', api.ListAIResponseSchema);
    return r.ais.map((a) => this.aiInfo(a));
  }

  private aiInfo(a: api.AIAccount): AIInfo {
    const user = toUser(a.user!);
    this.view.users = { ...this.view.users, [user.id]: { ...this.view.users[user.id], ...user } };
    this.emit();
    return { user, settings: a.settings, updatedAt: Number(a.settingsUpdatedAt), shareRequests: a.shareRequests };
  }

  async createAI(displayName: string) {
    return this.aiInfo(await this.call('POST', '/api/v1/ai', api.AIAccountSchema, { schema: api.CreateAIRequestSchema, value: { displayName } }));
  }

  async updateAI(id: string, value: { displayName?: string; avatarMediaId?: bigint; bio?: string }) {
    const u = toUser(await this.call('PATCH', `/api/v1/ai/${id}`, common.UserSchema, { schema: api.UpdateProfileRequestSchema, value }));
    this.view.users = { ...this.view.users, [u.id]: { ...this.view.users[u.id], ...u } };
    this.emit();
    return u;
  }

  // ---- my AI's plugins (docs/plugins.md) ----

  async listPlugins(aiId: string): Promise<PluginList> {
    const r = await this.call('GET', `/api/v1/ai/${aiId}/plugins`, api.ListPluginsResponseSchema);
    return { plugins: r.plugins.map(toPlugin), state: r.hostState, error: r.hostError, log: r.log, commandStart: r.commandStart };
  }

  /** Adds the plugins in a zip to my AI (new / changed ones wait for a site admin). */
  async uploadPlugins(aiId: string, zip: File): Promise<Plugin[]> {
    const info = await this.upload(zip);
    const r = await this.call('POST', `/api/v1/ai/${aiId}/plugins`, api.ListPluginsResponseSchema, {
      schema: api.UploadPluginsRequestSchema, value: { mediaId: info.id },
    });
    return r.plugins.map(toPlugin);
  }

  /** Turns a plugin on / off and patches its settings (key -> value, null = back to the default). */
  async updatePlugin(aiId: string, id: string, change: { enabled?: boolean; config?: Record<string, unknown> }): Promise<Plugin> {
    const p = await this.call('PATCH', `/api/v1/ai/${aiId}/plugins/${id}`, api.AIPluginSchema, {
      schema: api.UpdatePluginRequestSchema, value: { enabled: change.enabled, configJson: change.config ? JSON.stringify(change.config) : '' },
    });
    return toPlugin(p);
  }

  async deletePlugin(aiId: string, id: string) {
    await this.call('DELETE', `/api/v1/ai/${aiId}/plugins/${id}`, null);
  }

  /** Saves settings JSON; base = updatedAt it was edited from (state_conflict otherwise). */
  async putAISettings(id: string, settings: string, base: number) {
    return this.aiInfo(await this.call('PUT', `/api/v1/ai/${id}/settings`, api.AIAccountSchema, {
      schema: api.PutAISettingsRequestSchema, value: { settings, baseUpdatedAt: BigInt(base) },
    }));
  }

  /** A session token of my AI for this device (which then runs it). */
  async runAI(id: string) {
    const r = await this.call('POST', `/api/v1/ai/${id}/run`, api.SessionResponseSchema, { schema: api.RunAIRequestSchema, value: { deviceName: deviceName() } });
    return r.token;
  }

  /** Takes my AI out of a channel (it is put in with inviteMembers). */
  aiLeaveChannel(id: string, convId: string) {
    return this.call('DELETE', `/api/v1/ai/${id}/channels/${convId}`, null);
  }

  // ---- board games (docs/design.md §13 小游戏) ----

  /** Called for every game update (the AI runner watches these). */
  /** Optional AI memory checkpoints, loaded before fetching missed events. */
  memoryCursors?: () => Promise<Record<string, number>>;
  onGame?: (g: Game) => void;

  private putGame(g: Game) {
    const old = this.view.games[g.id];
    if (old && old.updatedAt > g.updatedAt) return; // an older push arriving late
    this.patch({ games: { ...this.view.games, [g.id]: g } });
    this.onGame?.(g);
  }

  async listGames(convId: string): Promise<Game[]> {
    const r = await this.call('GET', `/api/v1/conversations/${convId}/games`, api.ListGamesResponseSchema);
    const list = r.games.map(parseGame);
    const games = { ...this.view.games };
    for (const g of Object.values(games)) if (g.convId === convId && !list.some((x) => x.id === g.id)) delete games[g.id];
    for (const g of list) games[g.id] = g;
    this.patch({ games });
    return list;
  }

  private async gameCall(method: string, path: string, req?: { schema: DescMessage; value: object }): Promise<Game> {
    const g = parseGame(await this.call(method, path, common.GameSchema, req));
    this.putGame(g);
    return g;
  }

  openGame(convId: string, kind: GameKind, autoApprove: boolean) {
    return this.gameCall('POST', `/api/v1/conversations/${convId}/games`, { schema: api.OpenGameRequestSchema, value: { kind, autoApprove } });
  }

  /** join / start / leave / end, or rematch (a new game with the same players). */
  gameStep(id: string, step: 'join' | 'start' | 'leave' | 'end' | 'rematch') {
    return this.gameCall('POST', `/api/v1/games/${id}/${step}`);
  }

  /** 对局记录: finished games of a conversation ending before `before` (ms; 0 = now), newest first. */
  async gameHistory(convId: string, before = 0): Promise<Game[]> {
    const r = await this.call('GET', `/api/v1/conversations/${convId}/games?ended=1&before=${before}`, api.ListGamesResponseSchema);
    return r.games.map(parseGame);
  }

  /** Shows a game from the history (keeps it in the view so its window can open). */
  showGame(g: Game) {
    this.putGame(g);
  }

  decideGame(id: string, userId: string, approve: boolean) {
    return this.gameCall('POST', `/api/v1/games/${id}/applicants/${userId}`, { schema: api.DecideGameRequestSchema, value: { approve } });
  }

  setGameAuto(id: string, autoApprove: boolean) {
    return this.gameCall('PATCH', `/api/v1/games/${id}`, { schema: api.SetGameRequestSchema, value: { autoApprove } });
  }

  actGame(id: string, act: { action: 'move' | 'say' | 'vote' | 'resign' | 'ask' | 'guess'; x?: number; y?: number; text?: string; target?: number }) {
    return this.gameCall('POST', `/api/v1/games/${id}/act`, { schema: api.GameActRequestSchema, value: act });
  }

  // ---- an AI's portraits and share requests ----

  /** A bot / AI's own portrait pack: mood -> media id (empty = default pack). */
  async portraits(userId: string): Promise<Record<string, string>> {
    const r = await this.call('GET', `/api/v1/users/${userId}/portraits`, api.PortraitPackSchema);
    return Object.fromEntries(Object.entries(r.mediaIds).map(([k, v]) => [k, s(v)]));
  }

  async setPortraits(aiId: string, pack: Record<string, string>) {
    await this.call('PUT', `/api/v1/ai/${aiId}/portraits`, api.PortraitPackSchema, {
      schema: api.PortraitPackSchema, value: { mediaIds: Object.fromEntries(Object.entries(pack).map(([k, v]) => [k, BigInt(v)])) },
    });
  }

  requestShare(aiId: string) {
    return this.call('POST', `/api/v1/ai/${aiId}/share-request`, null, { schema: api.EmptySchema, value: {} });
  }

  async shareRequests(aiId: string): Promise<User[]> {
    const r = await this.call('GET', `/api/v1/ai/${aiId}/share-requests`, api.ShareRequestsSchema);
    this.addUsers(r.users);
    return r.users.map(toUser);
  }

  /** Answers a request; approved = they join its shared room (returns its id). */
  async decideShare(aiId: string, userId: string, approve: boolean): Promise<string | null> {
    // Rejected = an empty reply, which reads as a conversation with id 0.
    const c = await this.call('POST', `/api/v1/ai/${aiId}/share-requests/${userId}`, common.ConversationSchema, { schema: api.DecideShareRequestSchema, value: { approve } });
    if (!c.id) return null;
    this.upsertConv(c);
    return s(c.id);
  }

  /** A shared room with my AI (I add people to it like to any channel). */
  async createAIRoom(id: string, memberIds: string[] = []) {
    const c = await this.call('POST', `/api/v1/ai/${id}/room`, common.ConversationSchema, { schema: api.CreateAIRoomRequestSchema, value: { memberIds: memberIds.map(BigInt) } });
    this.upsertConv(c);
    return s(c.id);
  }

  async deleteAI(id: string) {
    await this.call('DELETE', `/api/v1/ai/${id}`, null);
    const u = this.view.users[id];
    if (u) this.patch({ users: { ...this.view.users, [id]: { ...u, gone: true } } });
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
      this.patch({ name: i.name || this.view.name, downloadUrl: i.downloadUrl, icon: i.icon, plugins: i.plugins });
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
      const f = await this.request({ case: 'auth', value: create(gw.AuthRequestSchema, { token: this.record.token!, address: this.record.endpoint.address }) });
      if (f.msg.case !== 'auth') throw new Error('unexpected reply');
      this.retry = 0;
      await this.onAuth(f.msg.value);
      const pub = f.msg.value.publicAddress;
      if (pub && pub !== this.record.endpoint.address) this.onMoved?.(pub);
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
    // Several tries failed: maybe the relay changed while we were away.
    if (this.retry === 3) this.onUnreachable?.();
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
      case 'serverMoved':
        if (f.msg.value.address && f.msg.value.address !== this.record.endpoint.address) this.onMoved?.(f.msg.value.address);
        break;
      case 'game': {
        this.putGame(parseGame(f.msg.value));
        break;
      }
      case 'aiShareRequest': {
        const p = f.msg.value;
        if (p.user) this.onShareRequest?.(s(p.aiId), toUser(p.user));
        break;
      }
      case 'remoteTool': {
        const p = f.msg.value;
        if (p.fromAi) this.onRemoteTool?.({ requestId: p.requestId, ai: toUser(p.fromAi), tool: p.tool, argsJson: p.argsJson });
        break;
      }
      case 'remoteToolResult': {
        const p = f.msg.value;
        const w = this.remoteWaits.get(p.requestId);
        // Only the person it asked may answer.
        if (w && w.from === s(p.fromUserId)) {
          this.remoteWaits.delete(p.requestId);
          w.done({ ok: p.ok, text: p.text, images: p.images });
        }
        break;
      }
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
      aiId: s(c.aiId) || undefined,
      lastSeq: Number(c.lastSeq),
      readSeq: Math.max(Number(c.self?.readSeq ?? 0n), prev?.readSeq ?? 0),
      myRole: role(c.self?.role ?? common.MemberRole.MEMBER),
      mutedUntil: Number(c.self?.mutedUntil ?? 0n),
      pinnedOrder: Number(c.self?.pinnedOrder ?? 0n),
      dndUntil: Number(c.self?.dndUntil ?? 0n),
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
    const checkpoints = await this.memoryCursors?.();
    for (const c of Object.values(convs)) {
      const local = this.view.messages[c.id];
      const newest = local?.filter((m) => !m.pending).at(-1)?.seq ?? 0;
      if (newest >= c.lastSeq) continue;
      const recent = Math.max(0, c.lastSeq - INITIAL_PAGE);
      const after = newest > 0 ? newest : Math.min(recent, checkpoints?.[c.id] ?? recent);
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
        .map((c) => ({ id: c.id, after: Number(r.events.filter((e) => s(e.convId) === c.id).at(-1)?.seq ?? c.after) }));
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
          // Someone joined / left / changed role: the server pushes the new
          // conversation only to that person, so fetch the member list again.
          if (live && body.kind === 'system' && MEMBER_CHANGES.has(body.sys.t)) this.refreshMembersSoon(convId);
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

  private askedUsers = new Set<string>();
  /** Makes sure a user's name is known (fetched once). */
  wantUser(id: string) {
    if (!id || this.view.users[id] || id === this.view.me?.id || this.askedUsers.has(id)) return;
    this.askedUsers.add(id);
    void this.fetchUser(id);
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

  /** mood: only for AI accounts (their portrait), see lib/ai/runner.ts. mentions: user ids @-mentioned in the text. */
  sendText(convId: string, text: string, mood?: string, mentions?: string[], replyTo?: string) {
    const m = mentions?.length ? mentions : undefined;
    return this.sendBody(convId, { case: 'text', value: create(ev.TextMsgSchema, { text, mood, mentions: m?.map(BigInt), replyTo: replyTo ? BigInt(replyTo) : undefined }) },
      { kind: 'text', text, mood, mentions: m, replyTo });
  }

  /** Removes a failed message from the list (it was never sent). */
  dropFailed(convId: string, msgId: string) {
    this.view.messages = { ...this.view.messages, [convId]: (this.view.messages[convId] ?? []).filter((m) => m.id !== msgId) };
    this.emit();
  }

  async upload(file: File, stickerSync = false) {
    const r = await this.t.upload(file, stickerSync);
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

  /** Sends a sticker (mine or one from the shared library): the picture with its first 10 tags (AIs read the tags). */
  sendSticker(convId: string, st: { mediaId: string; tags: string[] }) {
    const tags = st.tags.slice(0, 10);
    return this.sendBody(convId, { case: 'image', value: create(ev.ImageMsgSchema, { mediaId: BigInt(st.mediaId), stickerTags: tags }) },
      { kind: 'image', mediaId: st.mediaId, w: 0, h: 0, stickerTags: tags.length ? tags : undefined });
  }

  /** Reads a NetEase song / playlist link; the cover is copied into my uploads. */
  async resolveMusic(url: string) {
    const r = await this.call('POST', '/api/v1/music/resolve', api.ResolveMusicResponseSchema, { schema: api.ResolveMusicRequestSchema, value: { url } });
    return {
      kind: r.kind as 'song' | 'playlist', neteaseId: r.neteaseId, title: r.title, artist: r.artist,
      coverId: r.coverMediaId ? s(r.coverMediaId) : '', tracks: r.tracks.map((t) => ({ neteaseId: t.neteaseId, title: t.title, artist: t.artist })),
    };
  }

  // ---- someone else's computer (docs/design.md §9) ----

  /** (An AI's session) asks a person's devices to run a tool; resolves with their answer. */
  async remoteTool(toUserId: string, tool: string, argsJson: string, timeoutMs = 150_000): Promise<RemoteToolAnswer> {
    const requestId = randomId();
    const answer = new Promise<RemoteToolAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.remoteWaits.delete(requestId);
        resolve({ ok: false, text: '对方的电脑没有回应（可能不在线，或者没有回答）', images: [] });
      }, timeoutMs);
      this.remoteWaits.set(requestId, { from: toUserId, done: (r) => { clearTimeout(timer); resolve(r); } });
    });
    try {
      await this.request({ case: 'remoteTool', value: create(gw.RemoteToolRequestSchema, { requestId, toUserId: BigInt(toUserId), tool, argsJson }) });
    } catch (e) {
      this.remoteWaits.delete(requestId);
      throw e;
    }
    return answer;
  }

  /** (A person's device) answers an AI's request. */
  async remoteToolResult(ask: RemoteToolAsk, r: RemoteToolAnswer) {
    await this.request({ case: 'remoteToolResult', value: create(gw.RemoteToolResultSchema, {
      requestId: ask.requestId, toAiId: BigInt(ask.ai.id), ok: r.ok, text: r.text.slice(0, 60_000), images: r.images.slice(0, 2),
    }) });
  }

  // ---- stickers (my collection, lib/stickers.ts) ----

  async listStickers(): Promise<Sticker[]> {
    return (await this.call('GET', '/api/v1/stickers', api.ListStickersResponseSchema)).stickers.map(toSticker);
  }

  /** private undefined = the server's default (shared unless the server says otherwise). */
  async addSticker(mediaId: string, tags: string[] = [], priv?: boolean): Promise<Sticker> {
    return toSticker(await this.call('POST', '/api/v1/stickers', api.StickerSchema, { schema: api.AddStickerRequestSchema, value: { mediaId: BigInt(mediaId), tags, private: priv } }));
  }

  async setStickerPrivate(id: string, priv: boolean): Promise<Sticker> {
    return toSticker(await this.call('POST', `/api/v1/stickers/${id}/private`, api.StickerSchema, { schema: api.SetStickerPrivateRequestSchema, value: { private: priv } }));
  }

  /** One page of the shared library; next = offset of the next page, 0 = no more. */
  async stickerLibrary(q: string, sort: 'hot' | 'new', offset = 0): Promise<{ items: LibrarySticker[]; next: number; disabled: boolean }> {
    const qs = new URLSearchParams({ q, sort, offset: String(offset) });
    const r = await this.call('GET', `/api/v1/sticker-library?${qs}`, api.ListLibraryResponseSchema);
    return { items: r.items.map(toLibrary), next: r.nextOffset, disabled: r.disabled };
  }

  async collectSticker(libraryId: string): Promise<Sticker> {
    return toSticker(await this.call('POST', `/api/v1/sticker-library/${libraryId}/collect`, api.StickerSchema));
  }

  async editLibraryTags(libraryId: string, add: string[], remove: string[]): Promise<LibrarySticker> {
    return toLibrary(await this.call('PATCH', `/api/v1/sticker-library/${libraryId}/tags`, api.LibraryStickerSchema,
      { schema: api.EditLibraryTagsRequestSchema, value: { add, remove } }));
  }

  /** Which of these files (SHA-256) the shared library has: sha -> library id. */
  async lookupStickers(shas: string[]): Promise<Record<string, string>> {
    const r = await this.call('POST', '/api/v1/sticker-library/lookup', api.LookupStickersResponseSchema, { schema: api.LookupStickersRequestSchema, value: { sha256: shas } });
    return Object.fromEntries(Object.entries(r.libraryIds).map(([k, v]) => [k, s(v)]));
  }

  async setStickerTags(id: string, tags: string[]): Promise<Sticker> {
    return toSticker(await this.call('PATCH', `/api/v1/stickers/${id}`, api.StickerSchema, { schema: api.UpdateStickerRequestSchema, value: { tags } }));
  }

  deleteSticker(id: string) {
    return this.call('DELETE', `/api/v1/stickers/${id}`, null);
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

  private memberTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** One refresh for a burst of member changes (a channel filling up at once). */
  private refreshMembersSoon(convId: string) {
    if (this.memberTimers.has(convId)) return;
    this.memberTimers.set(convId, setTimeout(() => {
      this.memberTimers.delete(convId);
      if (this.view.convs[convId] && !this.view.convs[convId].left) void this.refreshConv(convId).catch(() => {});
    }, 300));
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

  /** Pins a channel / DM to the top of my list (all my devices). */
  async setPinned(convId: string, pinned: boolean) {
    this.upsertConv(await this.call('PUT', `/api/v1/conversations/${convId}/pin`, common.ConversationSchema, {
      schema: api.SetPinnedRequestSchema, value: { pinned },
    }));
  }

  /** Do not disturb until a time in ms (0 = off, -1 = until turned off). */
  async setDnd(convId: string, until: number) {
    this.upsertConv(await this.call('PUT', `/api/v1/conversations/${convId}/dnd`, common.ConversationSchema, {
      schema: api.SetDndRequestSchema, value: { until: BigInt(until) },
    }));
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

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '设备';
  return `AM ${os}`;
}
