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
  already_authenticated: '已经登录了',
  hosting_off: '这个服务器没开 AI 托管',
  hosting_limit: '你托管的 AI 已经到这个服务器的上限了（默认每人 1 个，等审批的也算）。先在另一个 AI 的设置 →「运行」里撤回或停止托管；要多托管几个，让服主在 config.toml 的 [hosting] max_per_user 调大',
  plugins_off: '这个服务器没开插件',
  plugin_limit: '插件已经装满了',
  museum_off: '这个服务器没开博物馆',
  museum_full: '一号展厅满了：选一个位置，把作品挂上去换下原来那幅',
  museum_nsfw: '这幅是 NSFW 作品，这个频道不让挂',
  museum_title: '这个标题不能用',
  museum_vote_open: '这幅作品还有一轮投票没结束',
  user_not_found: '找不到这个用户',
  self: '不能对自己这么做',
  blocked: '你们之间有一方屏蔽了对方，不能私信',
  not_public: '这是私密频道，需要有人邀请才能进',
  not_found: '找不到，可能已经被删除了',
  not_member: '你不在这个会话里',
  muted: '你在这个频道里被禁言了',
  empty_message: '消息是空的',
  too_long: '消息太长了',
  cannot_strike: '只能划掉自己的消息',
  already_struck: '已经划掉过了',
  no_permission: '你没有权限这么做',
  not_group: '这不是频道',
  invalid_group_name: '频道名要 1–32 个字',
  notice_too_long: '频道公告最多 1000 字',
  owner_cannot_leave: '频道主要先转让或者解散频道才能退出',
  group_full: '频道人数满了',
  no_join_request: '没有这个人的加入申请',
  not_in_group: '对方不在这个频道里',
  reason_required: '请填写原因',
  already_deleted: '这条消息已经被删除了',
  too_large: '文件太大了',
  blocked_media: '这张图片被管理员拉黑了',
  not_image: '不是支持的图片格式',
  bad_image: '图片读不出来，或者像素太大',
  media_not_found: '文件不存在或已被清理',
  bio_too_long: '个性签名最多 100 字',
  invalid_activity: '状态说明最多 32 字，自定义状态要写点内容',
  invalid_widget: '有个小组件的大小、位置或内容不对',
  layout_conflict: '刚才有人改过这个主页了，已经刷新，再改一次吧',
  left_server: '你已经退出了这个服务器，要服主给一个新的邀请码才能回来',
  too_many_devices: '这个账号登录的设备已经满了，先在一台设备上退出（账号设置 → 登录设备）',
  invalid_pair_code: '登录码不对、已经用过或者过期了，在旧设备上重新生成一个',
  state_conflict: '另一台设备刚改过，稍后再试',
  rate_limited: '操作太频繁了，等一会儿再试',
  ai_limit: 'AI 已经建到上限了',
  sticker_limit: '表情存满了，删掉一些再导入',
  sticker_tags_full: '这个表情的标签已经满了（最多 20 个）',
  sticker_library_off: '这个服务器关掉了公共表情库',
  game_bad_move: '这一步不行（位置被占了、不合规则，或者描述里直接说出了词）',
  not_your_turn: '还没轮到你',
  game_state: '这局现在不能这样做（还没开始或已经结束）',
  game_full: '人满了',
  game_limit: '这里同时开的游戏已经到上限了，先结束一局',
  music_link_invalid: '这不是网易云的歌曲或歌单链接',
  music_unavailable: '没能从网易云读到（链接不对，或者服务器连不上网易云）',
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
