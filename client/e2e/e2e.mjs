// Two-user browser test of the client against a real am-server.
// See client/README.md ("端到端测试") for how to run it.
import { chromium } from 'playwright';

const BASE = process.env.AM_E2E_URL ?? 'http://127.0.0.1:4173';
const JOIN = process.env.AM_E2E_JOIN; // admin join code of a fresh server (tls.mode = "off")
// Optional: admin join code of a second fresh server (vite with AM_DEV_SERVER2) to test 资料同步.
const JOIN2 = process.env.AM_E2E_JOIN2;
const IMAGE = process.env.AM_E2E_IMAGE; // any JPEG / PNG
const OUT = process.env.AM_E2E_OUT ?? '.';
if (!JOIN || !IMAGE) {
  console.error('set AM_E2E_JOIN and AM_E2E_IMAGE');
  process.exit(2);
}
const shot = (p, n) => p.screenshot({ path: `${OUT}/e2e-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = [];
(async () => {
  const b = await chromium.launch();
  const mk = async (scheme) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme || 'light' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const p = await ctx.newPage();
    pages.push(p);
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text()); });
    return p;
  };
  const A = await mk();
  await A.goto(BASE + '/');
  await A.fill('textarea[aria-label="加入码"]', JOIN);
  await A.click('button:has-text("下一步")');
  await A.waitForSelector('text=注册并进入');
  await shot(A, '01-register');
  await A.fill('input[autocomplete="username"]', 'weiqi');
  await A.fill('input[placeholder="不填就用用户名"]', 'Weiqi');
  await A.fill('input[type="password"]', 'password123');
  await A.click('button:has-text("注册并进入")');
  await A.waitForSelector('text=已连接');
  await wait(600);
  await shot(A, '02-empty-main');

  // Invites → copy first join code.
  await A.click('button[aria-label="账号设置"]');
  await A.waitForSelector('text=复制加入码');
  await wait(800);
  await shot(A, '03-invites');
  const joinCode = await A.locator('div.font-mono').first().getAttribute('title');

  // B: the join code is in the clipboard → banner on start.
  const B = await mk('dark');
  await B.goto(BASE + '/');
  await B.evaluate((t) => navigator.clipboard.writeText('快来 AM 找我玩 ' + t), joinCode);
  await B.reload();
  await B.waitForSelector('text=邀请你加入', { timeout: 8000 });
  await wait(500);
  await shot(B, '04-clipboard');
  await B.click('button:has-text("加入")');
  await B.fill('input[autocomplete="username"]', 'xiaoke');
  await B.fill('input[placeholder="不填就用用户名"]', '小克');
  await B.fill('input[type="password"]', 'password123');
  await B.click('button:has-text("注册并进入")');
  await B.waitForSelector('text=已连接');

  // Both are in the default public channel 大厅 (created for the first admin).
  await B.waitForSelector('aside button:has-text("大厅")');
  await A.click('button[aria-label="频道"]');
  await A.click('aside button:has-text("大厅")');
  await A.waitForSelector('text=小克 加入了频道');
  await A.fill('textarea[aria-label="消息"]', '欢迎来到大厅～');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await B.click('aside button:has-text("大厅")');
  await B.waitForSelector('text=欢迎来到大厅～');
  await shot(B, '05-hall-dark');

  // No friends: B finds A in the member list and sends a DM.
  await B.click('button[aria-label="私信"]');
  await B.click('button[aria-label="服务器成员"]');
  await B.waitForSelector('div[role="dialog"] >> text=@weiqi');
  await shot(B, '06-members-dark');
  await B.click('button[aria-label="私信 Weiqi"]');
  await B.waitForSelector('textarea[aria-label="消息"]');
  await B.fill('textarea[aria-label="消息"]', '能用！加入码粘贴一下就进来了，二维码也能扫');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await A.click('button[aria-label="私信"]');
  await A.click('aside button:has-text("小克")');
  await A.waitForSelector('text=加入码粘贴一下就进来了');
  await A.fill('textarea[aria-label="消息"]', '你好小克！新客户端能用了吗');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  // A sends an image.
  await A.setInputFiles('input[accept="image/*"][multiple]', IMAGE);
  await wait(1500);
  await B.waitForSelector('button[aria-label="查看图片"]');
  await wait(800);
  await shot(B, '07-dm-dark');

  // Block: B blocks A, A can no longer send; then unblock.
  await B.click('header button[aria-label="屏蔽"]');
  await B.click('div[role="dialog"] button:has-text("屏蔽")');
  await B.waitForSelector('textarea[placeholder^="你屏蔽了对方"]');
  await A.fill('textarea[aria-label="消息"]', '在吗');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('button[aria-label="发送失败"]');
  await B.click('header button[aria-label="取消屏蔽"]');
  await B.click('div[role="dialog"] button:has-text("取消屏蔽")');
  await B.waitForSelector('textarea[placeholder^="说点什么"]');

  // A creates a private channel with B.
  await A.click('button[aria-label="频道"]');
  await A.click('button[aria-label="新建频道"]');
  await A.fill('input[placeholder="给频道起个名字"]', 'AM 内测');
  await A.fill('div[role="dialog"] input[aria-label="搜索成员"]', 'xiao');
  await A.click('div[role="dialog"] button:has-text("小克")');
  await A.click('div[role="dialog"] button:has-text("新建")');
  await A.waitForSelector('header h2:has-text("AM 内测")');
  await A.fill('textarea[aria-label="消息"]', '欢迎来到内测频道，有 bug 直接说');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.fill('textarea[aria-label="消息"]', '这周六晚上八点开黑');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await wait(600);
  // Strike the last message via the context menu.
  await A.click('section div.whitespace-pre-wrap:has-text("这周六晚上八点开黑")', { button: 'right' });
  await A.click('button[role="menuitem"]:has-text("划掉")');
  await A.click('div[role="dialog"] button:has-text("划掉")');
  await wait(400);
  await A.fill('textarea[aria-label="消息"]', '改成周日晚上八点');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await B.click('button[aria-label="频道"]');
  await B.click('aside button:has-text("AM 内测")');
  await B.fill('textarea[aria-label="消息"]', '收到～');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await wait(1200);
  await shot(A, '08-channel');
  await A.hover('aside button:has-text("大厅")');
  await wait(400);
  await shot(A, '09-hover');

  // Presence: both online in the member list; signature and activity.
  await B.waitForSelector('aside >> text=在线 — 2');
  await A.click('button[aria-label="账号设置"]');
  await A.fill('textarea#bio', '今天也在写 AM');
  await A.click('button:has-text("保存签名")');
  await A.waitForSelector('text=签名已保存');
  // Status and invisible are set in 账号设置 too; the profile page only shows them.
  await A.click('button:has-text("正在听歌")');
  await A.fill('input[aria-label="歌名（可不填）"]', '晴天');
  await A.click('button:has-text("保存状态")');
  await A.waitForSelector('text=🎧 正在听歌：晴天');
  await A.click('button[aria-label="个人主页"]');
  await A.waitForSelector('text=今天也在写 AM');
  await A.waitForSelector('text=🎧 正在听歌：晴天');
  await wait(500); // the account page fades out first
  if (await A.locator('button:has-text("保存状态")').count()) throw new Error('status editor still on the profile page');
  await shot(A, '12-profile');
  await B.waitForSelector('aside >> text=🎧 正在听歌：晴天');
  await shot(B, '13-presence-dark');

  // Widgets: A fills the profile board; B opens it from the member list and leaves a note.
  await A.click('button:has-text("编辑主页")');
  const addWidget = async (label) => {
    await A.click('button:has-text("添加")');
    await A.click(`div[role="dialog"] button:has-text("${label}")`);
    await wait(400);
  };
  await addWidget('文字卡片');
  await A.fill('div[role="dialog"] input[maxlength="40"]', '关于我');
  await A.fill('div[role="dialog"] textarea', '在做 AM，一个自己的聊天软件。');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await addWidget('照片墙');
  await A.setInputFiles('div[role="dialog"] input[type="file"]', [IMAGE, IMAGE]);
  await A.waitForSelector('text=2 / 20 张');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await addWidget('统计');
  await A.click('div[role="dialog"] button:has-text("4×1")');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await addWidget('留言板');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await A.click('button:has-text("背景")');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("渐变")');
  await A.click('div[role="dialog"] button[aria-label="ocean"]');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await A.getByRole('button', { name: '保存', exact: true }).click();
  await A.waitForSelector('text=主页已保存');
  await wait(800);
  await shot(A, '18-profile-widgets');
  await B.click('aside[aria-label="频道成员"] button:has-text("Weiqi")');
  await B.click('button[role="menuitem"]:has-text("查看主页")');
  await B.waitForSelector('text=关于我');
  await B.fill('input[aria-label="留言"]', '主页好看！');
  await B.press('input[aria-label="留言"]', 'Enter');
  await B.waitForSelector('text=主页好看！');
  await wait(600);
  await shot(B, '19-visit-profile-dark');
  await B.click('button[aria-label="频道"]');
  await B.waitForSelector('aside >> text=在线 — 2');
  // Invisible: B sees A offline; A still sees itself as invisible.
  await A.click('button[aria-label="账号设置"]');
  await A.click('button[role="switch"][aria-label="隐身"]');
  await B.waitForSelector('aside >> text=离线 — 1');
  await A.waitForSelector('text=（隐身中）');
  // Folding both side columns (kept per device).
  await B.click('button[aria-label="收起列表"]');
  await B.click('button[aria-label="收起成员列表"]');
  await wait(900);
  await shot(B, '14-folded-dark');
  await B.reload();
  await B.click('button[aria-label="AM 内测"]'); // still folded after a reload
  await B.waitForSelector('button[aria-label="展开成员列表"]');
  await B.click('button[aria-label="展开成员列表"]');
  await B.click('button[aria-label="展开列表"]');
  await A.click('button[role="switch"][aria-label="隐身"]');
  await B.waitForSelector('aside >> text=在线 — 2');
  await A.click('button[aria-label="频道"]');

  // Pin and do not disturb (right-click a channel; my own setting).
  await B.click('aside button:has-text("AM 内测")', { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("置顶")');
  await B.waitForSelector('aside button:has-text("AM 内测") [aria-label="已置顶"]');
  if (!(await B.locator('aside[aria-label="频道"] div.overflow-y-auto > button').first().textContent()).includes('AM 内测')) throw new Error('pinned channel not first');
  await B.click('aside button:has-text("大厅")', { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("免打扰 1 小时")');
  await B.waitForSelector('aside button:has-text("大厅") [aria-label="免打扰"]');
  await A.click('aside button:has-text("大厅")');
  await A.fill('textarea[aria-label="消息"]', '免打扰的频道不响也不算红点');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await wait(800);
  await shot(B, '26-pin-dnd-dark');
  await B.click('aside button:has-text("大厅")', { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("关闭免打扰")');
  await B.waitForSelector('aside button:has-text("大厅") [aria-label="免打扰"]', { state: 'detached' });

  // Browse public channels.
  await A.click('button[aria-label="浏览公开频道"]');
  await A.waitForSelector('div[role="dialog"] >> text=2 人');
  await shot(A, '10-browse');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="设置"]');
  await wait(700);
  await shot(A, '11-settings');

  // Server list -> server profile.
  await A.click('button[aria-label="频道"]');
  await A.click('button[aria-label="服务器列表"]');
  await A.click('button[aria-label$="的服务器主页"]');
  await A.waitForSelector('text=位成员');
  await wait(600);
  await shot(A, '15-server-profile');

  // B leaves the server: back to the join screen, can enter the empty main view.
  await B.click('button[aria-label="服务器列表"]');
  await B.click('button[aria-label$="的服务器主页"]');
  await B.click('button:has-text("退出服务器")');
  await B.click('div[role="dialog"] button:has-text("退出服务器")');
  await B.waitForSelector('textarea[aria-label="加入码"]');
  await shot(B, '16-welcome-after-leave');
  await B.click('button:has-text("先不加入，进入主界面")');
  await B.waitForSelector('text=还没有服务器');
  await shot(B, '17-no-server');
  await A.click('button[aria-label="频道"]');
  await A.click('aside button:has-text("AM 内测")');
  await A.waitForSelector('text=小克 退出了频道');

  // Coming back needs a new invite: log in with a join code that carries one.
  await A.click('button[aria-label="账号设置"]');
  await A.waitForSelector('div.font-mono[title^="AM1-"]');
  const again = await A.locator('div.font-mono[title^="AM1-"]').first().getAttribute('title');
  await B.click('button:has-text("加入服务器")');
  await B.fill('textarea[aria-label="加入码"]', again);
  await B.click('button:has-text("下一步")');
  await B.click('button:has-text("我已经有这个服务器的账号，直接登录")');
  await B.waitForSelector('text=以前退出过这个服务器'); // login form is in (after the slide)
  // The login from registering was saved on this device: nothing to type.
  await B.waitForSelector('text=密码用这台设备保存的');
  await wait(400);
  await B.click('form button[type="submit"]:has-text("登录")');
  await B.waitForSelector('text=已连接');
  await B.waitForSelector('aside button:has-text("大厅")');

  // 多设备: A makes a pairing code, a new device (C) logs in with it and
  // gets A's servers, saved login and settings.
  await A.click('button[aria-label="账号设置"]');
  await A.click('button[role="radio"]:has-text("10 秒")'); // a setting that should come along
  await A.click('button[role="radio"]:has-text("登录设备")');
  await A.waitForSelector('text=已登录 1 / 3 台设备');
  await A.click('button:has-text("添加新设备")');
  await A.waitForSelector('div[role="dialog"] div.font-mono:has-text("AMP-")');
  const pairCode = (await A.locator('div[role="dialog"] div.font-mono').textContent()).trim();
  await wait(400);
  await shot(A, '23-pair-code');
  const C = await mk();
  await C.goto(BASE + '/');
  await C.click('button:has-text("从已有设备登录")');
  await C.fill('textarea[aria-label="登录码"]', pairCode);
  await C.click('form button[type="submit"]:has-text("登录")');
  await C.waitForSelector('text=已连接');
  await C.waitForSelector('text=已登录你所有的服务器');
  await A.waitForSelector('text=新设备已登录', { timeout: 10000 });
  await shot(A, '24-paired');
  await A.click('div[role="dialog"] button:has-text("好的")');
  await A.waitForSelector('text=已登录 2 / 3 台设备');
  await C.click('button[aria-label="账号设置"]');
  await C.waitForSelector('text=用户名 weiqi');
  await C.waitForSelector('button[role="radio"][aria-checked="true"]:has-text("10 秒")');
  // The code works once.
  const D = await mk();
  await D.goto(BASE + '/');
  await D.click('button:has-text("从已有设备登录")');
  await D.fill('textarea[aria-label="登录码"]', pairCode);
  await D.click('form button[type="submit"]:has-text("登录")');
  await D.waitForSelector('text=登录码不对、已经用过或者过期了');
  await D.close();

  if (JOIN2) {
    // 资料同步: A joins a second server with "用我的资料" (saved login, no typing);
    // name, signature, status and the profile board are copied over.
    await A.click('button[aria-label="账号设置"]');
    await A.click('button[role="radio"]:has-text("10 秒")');
    await A.click('button[aria-label="频道"]');
    await A.click('button[aria-label="服务器列表"]');
    await A.click('button:has-text("加入新服务器")');
    await A.fill('textarea[aria-label="加入码"]', JOIN2);
    await A.click('button:has-text("下一步")');
    await A.waitForSelector('text=用我的资料：Weiqi');
    await A.waitForSelector('text=密码用这台设备保存的');
    await wait(400);
    await shot(A, '20-join-with-profile');
    await A.click('button:has-text("注册并进入")');
    await A.waitForSelector('text=已把你的资料复制到', { timeout: 20000 });
    await A.click('button[aria-label="个人主页"]');
    await A.waitForSelector('text=今天也在写 AM');
    await A.waitForSelector('text=🎧 正在听歌：晴天');
    await A.waitForSelector('text=关于我');
    await wait(800);
    await shot(A, '21-copied-profile');
    // A change here reaches the first server after the delay.
    await A.click('button[aria-label="账号设置"]');
    await A.fill('textarea#bio', '两个服务器一个我');
    await A.click('button:has-text("保存签名")');
    await A.waitForSelector('text=都同步好了', { timeout: 25000 });
    await shot(A, '22-sync-card');
    await A.click('button[aria-label="频道"]');
    await A.click('button[aria-label="服务器列表"]');
    await A.click('button[aria-label^="切换到 "]:not([aria-label="切换到 第二服"])');
    await A.click('button[aria-label="个人主页"]');
    await A.waitForSelector('text=两个服务器一个我');

    // The paired device is offered the server A joined, and joins it with the saved login.
    await C.click('button[aria-label="频道"]');
    await C.waitForSelector('[aria-label="其他设备上有新服务器"]', { timeout: 15000 });
    await C.click('button[aria-label="服务器列表"]');
    await C.waitForSelector('text=你在另一台设备上加入了');
    await wait(400);
    await shot(C, '25-offer');
    await C.click('button:has-text("加入")');
    await C.waitForSelector('text=第二服');
    await C.waitForSelector('text=已连接');
    await C.click('button[aria-label="个人主页"]');
    await C.waitForSelector('text=两个服务器一个我');
  }
  await b.close();
  console.log('E2E OK');
})().catch(async (e) => {
  console.error('E2E FAIL', e);
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${OUT}/e2e-fail-${i}.png` }).catch(() => {})));
  process.exit(1);
});
