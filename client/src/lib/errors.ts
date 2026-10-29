// Server error codes (docs/protocol.md) in plain Chinese.
const TEXT: Record<string, string> = {
  bad_request: '请求格式不对',
  unauthorized: '登录已失效，请重新登录',
  banned: '这个账号已被封禁',
  wrong_credentials: '用户名或密码不对',
  invalid_invite: '邀请码无效或已经用过了',
  username_taken: '这个用户名已经有人用了',
  invalid_username: '用户名只能是 3–20 位字母、数字或下划线',
  weak_password: '密码至少 8 位',
  invalid_display_name: '昵称要 1–32 个字',
  invite_limit: '邀请码已经用完了',
  user_not_found: '找不到这个用户',
  self: '不能对自己这么做',
  already_friends: '你们已经是好友了',
  no_request: '没有这个人的好友申请',
  not_friends: '你们还不是好友',
  not_found: '找不到，可能已经被删除了',
  not_member: '你不在这个会话里',
  muted: '你在这个群里被禁言了',
  empty_message: '消息是空的',
  too_long: '消息太长了',
  cannot_strike: '只能划掉自己的消息',
  already_struck: '已经划掉过了',
  no_permission: '你没有权限这么做',
  not_group: '这不是群聊',
  invalid_group_name: '群名要 1–32 个字',
  notice_too_long: '群公告最多 1000 字',
  owner_cannot_leave: '群主要先转让群或者解散群才能退出',
  group_full: '群已经满了',
  no_join_request: '没有这个人的入群申请',
  not_in_group: '对方不在群里',
  reason_required: '请填写原因',
  already_deleted: '这条消息已经被删除了',
  too_large: '文件太大了',
  blocked_media: '这张图片被管理员拉黑了',
  not_image: '不是支持的图片格式',
  bad_image: '图片读不出来，或者像素太大',
  media_not_found: '文件不存在或已被清理',
  rate_limited: '操作太频繁了，等一会儿再试',
  internal_error: '服务器出错了',
};

export class ApiError extends Error {
  constructor(public code: string, message?: string) {
    super(TEXT[code] ?? message ?? code);
  }
}

/** Turns an HTTP reply body ({"code","message"}) into an ApiError. */
export function errorFromBody(status: number, body: string): ApiError {
  try {
    const j = JSON.parse(body) as { code?: string; message?: string };
    if (j.code) return new ApiError(j.code, j.message);
  } catch {
    /* not JSON */
  }
  return new ApiError('http_' + status, `服务器返回 ${status}`);
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
