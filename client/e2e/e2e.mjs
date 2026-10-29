// Two-user browser test of the client against a real am-server.
// See client/README.md ("端到端测试") for how to run it.
import { chromium } from 'playwright';

const BASE = process.env.AM_E2E_URL ?? 'http://127.0.0.1:4173';
const JOIN = process.env.AM_E2E_JOIN; // admin join code of a fresh server (tls.mode = "off")
const IMAGE = process.env.AM_E2E_IMAGE; // any JPEG / PNG
const OUT = process.env.AM_E2E_OUT ?? '.';
if (!JOIN || !IMAGE) {
  console.error('set AM_E2E_JOIN and AM_E2E_IMAGE');
  process.exit(2);
}
const shot = (p, n) => p.screenshot({ path: `${OUT}/e2e-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  const mk = async (scheme) => {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme || 'light' });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const p = await ctx.newPage();
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
  await A.click('button[aria-label="我"]');
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

  // B adds A as friend, A accepts.
  await B.click('button[aria-label="联系人"]');
  await B.click('button:has-text("加好友")');
  await B.fill('input[placeholder="例如 xiaoke"]', 'weiqi');
  await B.click('button:has-text("发送申请")');
  await wait(800);
  await A.click('button[aria-label="联系人"]');
  await A.click('button[role="radio"]:has-text("新朋友")');
  await A.waitForSelector('text=想加你为好友');
  await shot(A, '05-request');
  await A.click('button:has-text("同意")');
  await wait(500);
  await A.click('button[role="radio"]:has-text("好友")');
  await A.click('button[aria-label="和 小克 聊天"]');
  await A.waitForSelector('textarea[aria-label="消息"]');
  await A.fill('textarea[aria-label="消息"]', '你好小克！新客户端能用了吗');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await wait(800);

  // B sees the conversation and replies.
  await B.click('button[aria-label="消息"]');
  await B.waitForSelector('text=你好小克！新客户端能用了吗');
  await B.click('text=Weiqi >> nth=0');
  await B.fill('textarea[aria-label="消息"]', '能用！加入码粘贴一下就进来了，二维码也能扫');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('text=加入码粘贴一下就进来了');
  // A sends an image.
  await A.setInputFiles('input[accept="image/*"][multiple]', IMAGE);
  await wait(1500);
  await B.waitForSelector('button[aria-label="查看图片"]');
  await wait(800);
  await shot(B, '06-dm-dark');

  // A creates a group with B.
  await A.click('button[aria-label="联系人"]');
  await A.click('button:has-text("建群")');
  await A.fill('input[placeholder="给群起个名字"]', 'AM 内测群');
  await A.click('div[role="dialog"] button:has-text("小克")');
  await A.click('div[role="dialog"] button:has-text("建群（")');
  await A.waitForSelector('text=创建了群聊');
  await A.fill('textarea[aria-label="消息"]', '欢迎来到内测群，有 bug 直接说');
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
  await B.click('text=AM 内测群 >> nth=0');
  await B.fill('textarea[aria-label="消息"]', '收到～');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await wait(1200);
  await shot(A, '07-group');
  await A.hover('button:has-text("AM 内测群")');
  await wait(400);
  await shot(A, '08-hover');
  await A.click('button[aria-label="设置"]');
  await wait(700);
  await shot(A, '09-settings');
  await b.close();
  console.log('E2E OK');
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });
