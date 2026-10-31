// View models used by the UI. session.ts converts protocol messages
// (proto/am/v1) into these. Ids are strings (protocol int64).

export type AccountType = 'human' | 'bot' | 'ai';
export type MemberRole = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  name: string;
  type: AccountType;
  ownerId?: string;
  /** Owner's display name for bot / ai accounts (stamped by the server). */
  ownerName?: string;
  /** Media path of the avatar (may be a GIF) and of its static first frame. */
  avatar?: string;
  avatarStatic?: string;
  /** Personal signature (profile page). */
  bio: string;
}

export type ActivityKind = 'listening' | 'playing' | 'tuning_ai' | 'working' | 'custom';

/** What someone says they are doing ("正在听歌：晴天"). */
export interface Activity {
  kind: ActivityKind;
  text: string;
}

/** Online state as this user sees it. Only online people have an entry. */
export interface Presence {
  /** Online but invisible: only set for yourself and your own bot / AI accounts. */
  invisible?: boolean;
  activity?: Activity;
}

export interface Member {
  userId: string;
  role: MemberRole;
}

export interface Conversation {
  id: string;
  kind: 'dm' | 'group';
  name: string;
  avatar?: string;
  ownerId?: string;
  /** For DMs: the other person. */
  peerId?: string;
  members: Member[];
  notice: string;
  joinApproval: boolean;
  /** Channel (group) open to everyone on the server. */
  public: boolean;
  lastSeq: number;
  readSeq: number;
  myRole: MemberRole;
  mutedUntil: number;
  /** My pin (0 = not pinned; larger = higher). Shared by my devices. */
  pinnedOrder: number;
  /** My do-not-disturb end in ms (0 = off, -1 = until turned off). */
  dndUntil: number;
  lastText: string;
  lastTime: number;
  /** Set when you left / were removed; the history stays readable. */
  left?: 'left' | 'kicked' | 'dissolved';
}

/** A system event, rendered to text with the current names. */
export type SysEvent =
  | { t: 'created'; op: string }
  | { t: 'name'; op: string; name: string }
  | { t: 'notice'; op: string }
  | { t: 'avatar'; op: string }
  | { t: 'approval'; op: string; on: boolean }
  | { t: 'dissolved'; op: string }
  | { t: 'join'; op: string; target: string }
  | { t: 'leave'; target: string }
  | { t: 'kick'; op: string; target: string }
  | { t: 'mute'; op: string; target: string; until: number }
  | { t: 'unmute'; op: string; target: string }
  | { t: 'role'; op: string; target: string; role: MemberRole };

export type MessageBody =
  | { kind: 'text'; text: string; replyTo?: string; mood?: string }
  | { kind: 'image'; mediaId: string; w: number; h: number }
  | { kind: 'file'; mediaId: string; name: string; size: number }
  | { kind: 'deleted'; byId: string; reason: string }
  | { kind: 'system'; sys: SysEvent };

export interface Message {
  /** Event id, or "local-…" while sending. */
  id: string;
  seq: number;
  senderId: string;
  time: number;
  body: MessageBody;
  /** The sender struck this message through (it stays visible). */
  struck?: boolean;
  clientMsgId?: string;
  pending?: boolean;
  failed?: string;
}

export interface Invite {
  code: string;
  joinCode: string;
  joinUrl: string;
  usedBy?: string;
}

export interface JoinRequest {
  user: User;
  inviter: User;
  time: number;
}

/** A public channel in "browse channels". */
export interface ChannelInfo {
  id: string;
  name: string;
  avatar?: string;
  notice: string;
  memberCount: number;
  joined: boolean;
}
