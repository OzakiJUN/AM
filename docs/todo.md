# 待办（Weiqi 已提出、还没做的需求）

> 做完一条就删掉，并在 CHANGELOG / design.md 里记下。新会话先读这里。

1. **表情包功能**：还没做（第三阶段，见 design.md 第 11 节）。单独一批做。
2. **Live2D 立绘（计划，难）**：见 design.md 第 9 节（已记了 AI VTuber 项目的做法和许可调研）。做个能跑的样例再定格式；发布前确认许可。
3. 新的 `neutral` 是黑丝袜、看不到尾巴，其他 17 张是白袜、有尾巴，切表情时腿会变色。Weiqi：先不管，以后再说（先把功能做好）。
4. **工坊小组件**（第五阶段）：运行时、联网白名单、别人没装也能看（服务器存组件包 + 验签 + 截图兜底），设计见 design.md 第 13 节；布局格式已经留好字段。
5. 「正在听歌 / 打游戏」以后可以由客户端自动识别（现在要手动选）。
6. 以后收藏的表情包（第三阶段）也要加进资料同步（design.md 第 7 节「资料同步」）。
7. **bot / AI 账号的管理放到 AI 栏**（第二阶段做 bot 时）：主页、资料、在哪些频道等都在 AI 栏里设置（design.md 第 10 节）。
8. 安卓端：存密码和共享密钥要接 Android Keystore（现在只有 Windows 凭据管理器），扫登录码 / 加入码用摄像头（Tauri 扫码插件）。
9. **自动更新**（方案已定，见 design.md 第 3 节「更新」）：AI 功能做好、给朋友试之前完成。
10. **AI 第 2b 批：操作电脑（续）**（design.md 第 9 节「操作电脑」）：Windows 界面自动化、AI 自己的浏览器窗口、MCP、游戏（截图 + 虚拟手柄）。2a（文件、命令、截屏、键鼠、权限、急停、记录）已完成。用真的 DeepSeek key 测一遍工具调用（云端开发环境要先放开 api.deepseek.com）。
11. **AI 第 3 批**：人格无感自我迭代、AI 进频道（被 @ 回复、离线补回）、共享 AI、别人的 AI 操作我的电脑（经服务器转发）。
12. AI 余额查询和低余额提醒；AI 形象包（自定义立绘）上传。
13. **工坊默认小游戏**（第五阶段，Weiqi 提的）：跟 AI 一起玩、让不同人的 AI 坐一桌玩桌游（AI 们各自跑在主人的设备上，经服务器同步牌局）。
14. **AI 玩游戏**：优先用游戏自己的接口 / mod（例如 Minecraft 用 mineflayer 机器人，不占鼠标），没有接口的才截图 + 键鼠 / 虚拟手柄。参考项目：dsh-game-bridge（DeepSeek Harness 的游戏插件：DXcam 截屏 + RapidOCR，虚拟 Xbox 手柄 ViGEmBus + SendInput；F12 一键收回控制、游戏窗口不在前台就不动、反作弊游戏直接拒绝、默认只演练不真按、操作留记录——第 2 批的「让鼠标」和急停照这个思路），ZerolanLiveRobot（B 站弹幕 + 看屏幕 + mineflayer 操作 Minecraft）、DeepSeek Harness（DeepSeek 开源的 agent 框架，插件式，开发者预览版）、AI-XiaoPi（弹幕 → 模型 → TTS 的直播助手）、digital-human-livestream（LiveTalking 二次开发：B 站弹幕 → DeepSeek → EdgeTTS → wav2lip / MuseTalk 数字人，要 CUDA 显卡）。以后做 AI 直播 / 语音时再细看。
