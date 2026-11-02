// Two-user browser test of the client against a real am-server.
// See client/README.md ("端到端测试") for how to run it.
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
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
// A fake model service (OpenAI-compatible, streamed) for the AI scenario.
const MOCK_PORT = Number(process.env.AM_E2E_MOCK_PORT ?? 8460);
let seenTools = [];
let seenHelperPrompt = false;
const GAME_MOVES = ['I9', 'G9', 'I7', 'G7'];
let gameMove = 0;
// A local creative workshop: a signed index (test key = seed 7×32, build the
// client with AM_DEV_WORKSHOP=http://127.0.0.1:<mock port>/workshop and
// AM_DEV_WORKSHOP_KEY=6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=) and packages.
let workshop = null;
function workshopFiles() {
  if (workshop) return workshop;
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]), format: 'der', type: 'pkcs8' });
  const j = (o) => Buffer.from(JSON.stringify(o));
  const img = readFileSync(IMAGE);
  const img2 = readFileSync(`${OUT}/e2e-01-register.png`);
  const man = (type, id, name, extra = {}) => j({ format: 1, type, id, name, version: '1.0.0', author: 'OzakiJUN', description: `测试用的${name}`, ...extra });
  const zips = {
    'theme.zip': zipSync({ 'manifest.json': man('theme', 'test.sakura', '樱花主题', { theme: { mode: 'dark', accent: '#3a8ddf', background: 'bg.png', bgDim: 0.4 } }), 'bg.png': img }),
    'stickers.zip': zipSync({ 'manifest.json': man('stickers', 'test.cats', '猫猫表情'), 'a.png': img, 'b.png': img2, 'tags.json': j({ 'a.png': ['猫猫', '工坊'] }) }),
    'persona.zip': zipSync({ 'manifest.json': man('persona', 'test.neko', '猫娘'), 'persona.json': j({ intro: '工坊里的猫娘', system: '你是一只猫娘，句尾加喵。', examples: '', greeting: '喵～' }) }),
  };
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const item = (id, type, name, file, extra = {}) => ({
    id, type, name, author: 'OzakiJUN', repo: 'OzakiJUN/am-test', version: '1.0.0', url: `http://127.0.0.1:${MOCK_PORT}/workshop/${file}`,
    sha256: sha(zips[file]), size: zips[file].length, summary: `测试用的${name}`, ...extra,
  });
  const items = [
    item('test.sakura', 'theme', '樱花主题', 'theme.zip'),
    item('test.cats', 'stickers', '猫猫表情', 'stickers.zip'),
    item('test.neko', 'persona', '猫娘', 'persona.zip'),
    // Registered with another SHA-256: the download must be refused.
    item('test.broken', 'theme', '坏掉的包', 'theme.zip', { sha256: '0'.repeat(64) }),
    item('test.gone', 'theme', '下架的主题', 'theme.zip', { disabled: '测试下架' }),
  ];
  const index = j({ format: 1, generated_at: Date.now(), max_package_mb: 20, items });
  workshop = { 'index.json': index, 'index.sig': Buffer.from(edSign(null, index, key).toString('base64')), ...zips };
  // A package to install from a file (not in the index).
  writeFileSync(`${OUT}/sideload.zip`, zipSync({ 'manifest.json': man('theme', 'me.local', '本地主题', { theme: { accent: '#1fae93' } }) }));
  return workshop;
}

const naiRequests = [];
const mock = createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/workshop/')) {
    const f = workshopFiles()[req.url.slice('/workshop/'.length)];
    res.writeHead(f ? 200 : 404, { 'Access-Control-Allow-Origin': '*' });
    return res.end(f ?? '');
  }
  // Also a fake NetEase for the music widgets (the test server's media.netease_api points here).
  if (req.method === 'GET' && req.url.startsWith('/api/song/detail/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 200, songs: [{ id: 186016, name: '晴天', artists: [{ name: '周杰伦' }], album: { picUrl: `http://127.0.0.1:${MOCK_PORT}/cover.png` } }] }));
  }
  if (req.method === 'GET' && req.url.startsWith('/cover.png')) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(readFileSync(IMAGE));
  }
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  // A fake NovelAI (the test server's [draw] api is http://127.0.0.1:<mock port>/nai).
  if (req.url.startsWith('/nai/')) {
    if (req.headers.authorization !== 'Bearer nai-test') return res.writeHead(401, cors).end('{"message":"bad token"}');
    const path = req.url.slice(4);
    if (path.startsWith('/user/subscription')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tier: 3, expiresAt: 1900000000, trainingStepsLeft: { fixedTrainingStepsLeft: 1000, purchasedTrainingSteps: 0 }, usage: { percent: 90 } }));
    }
    if (path.startsWith('/ai/generate-image/suggest-tags')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tags: [{ tag: 'artist:mika pikazo', count: 1234, confidence: 0.9 }] }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      naiRequests.push(j);
      const n = j.parameters?.n_samples ?? 1;
      const files = {};
      for (let i = 0; i < n; i++) files[`image_${i}.png`] = new Uint8Array(readFileSync(IMAGE));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/zip' });
      res.end(Buffer.from(zipSync(files)));
    });
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = JSON.parse(body || '{}');
    if (req.headers.authorization !== 'Bearer sk-test') return res.writeHead(401, cors).end('{"error":{"message":"bad key"}}');
    const last = j.messages?.at(-1)?.content ?? '';
    if (j.tools) seenTools = j.tools.map((t) => t.function.name);
    if ((j.messages?.find((m) => m.role === 'system')?.content ?? '').includes('· /投厕')) seenHelperPrompt = true;
    // The server's bot asks without streaming (translating a drawing description, naming a picture…).
    if (j.stream === false) {
      const sys = j.messages?.find((m) => m.role === 'system')?.content ?? '';
      const content = sys.startsWith('You are a translator') ? 'a girl with silver hair and cat ears' : '好的';
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    // Asked to draw: the draw_picture tool, then a word about it.
    if (last.includes?.('给我画') && j.messages.at(-1).role === 'user' && j.tools?.some((t) => t.function.name === 'draw_picture')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_d', function: { name: 'draw_picture', arguments: '{"prompt":"1girl, solo, sunflower field","orientation":"square"}' } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    // Asked to use the clipboard: call the tool first, then answer.
    const wantsTool = last.includes?.('剪贴板') && j.messages.at(-1).role === 'user' && j.tools?.some((t) => t.function.name === 'set_clipboard');
    // Asked to look at someone else's computer: use_computer_of, then answer with what came back.
    const wantsRemote = last.includes?.('小克的电脑') && j.messages.at(-1).role === 'user' && j.tools?.some((t) => t.function.name === 'use_computer_of');
    if (wantsRemote) {
      const args = JSON.stringify({ person: '小克', tool: 'get_clipboard', args_json: '{}' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r', function: { name: 'use_computer_of', arguments: args } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (wantsTool) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'set_clipboard', arguments: '{"text":"小鱼' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '到此一游"}' } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // A board game turn: move with game_move (the next free point of a fixed list), then stay quiet.
    const game = typeof last === 'string' && j.messages.at(-1).role === 'user' && j.tools?.some((t) => t.function.name === 'game_move')
      ? /游戏编号 (\d+)[\s\S]*轮到你了：用 game_move/.exec(last) : null;
    if (game) {
      const at = GAME_MOVES[gameMove++ % GAME_MOVES.length];
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_g', function: { name: 'game_move', arguments: JSON.stringify({ game_id: game[1], at }) } }] } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    // In a channel: answer when @-mentioned, otherwise stay quiet with [skip].
    const sys = j.messages?.find((m) => m.role === 'system')?.content ?? '';
    if (sys.includes('你现在在频道')) {
      const said = typeof last === 'string' && last.includes('@小鱼') ? '[mood:happy] 我在！' : '[skip]';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: said } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    const toolResult = j.messages?.filter((m) => m.role === 'tool').at(-1)?.content;
    const pieces = toolResult ? ['[mood:smug] 放好啦（', toolResult, '）'] : ['[mood:', 'shy] 喵～', '收到：', last];
    for (const piece of pieces) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    res.end('data: [DONE]\n\n');
  });
}).listen(MOCK_PORT, '127.0.0.1');
// A short silent WAV for the music widget (8 kHz, 8-bit, mono, 0.6 s).
// (ASCII name: Playwright silently drops files whose path has Chinese characters.)
const SONG = `${OUT}/Test Band - Quiet.wav`;
{
  const n = 4800;
  const b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  writeFileSync(SONG, b);
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
    p.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.request().method(), r.url()); });
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
  // A's member list picked up the newcomer without reloading.
  await A.waitForSelector('header >> text=公开频道 · 2 人');
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
  await B.waitForSelector('aside >> text=在线 — 3'); // A, B and 小助手 (always online)
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
  // Our own music player: a song uploaded to the server (a short silent WAV made here).
  await addWidget('一首歌');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("上传文件")');
  await A.setInputFiles('div[role="dialog"] input[type="file"][accept^="audio"]', SONG);
  await A.waitForSelector('div[role="dialog"] button:has-text("换一首")');
  await A.fill('div[role="dialog"] input[maxlength="40"]', '测试乐队');
  await A.click('div[role="dialog"] button:has-text("好了")');
  // …and a NetEase song by its share link: title, artist and cover are read by the server.
  await addWidget('一首歌');
  await A.fill('div[role="dialog"] input[aria-label="网易云链接"]', '分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=186016 (来自@网易云音乐)');
  await A.click('div[role="dialog"] button:has-text("读取")');
  await A.waitForSelector('div[role="dialog"] >> text=现在：晴天 - 周杰伦');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await A.click('button:has-text("背景")');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("渐变")');
  await A.click('div[role="dialog"] button[aria-label="ocean"]');
  await A.click('div[role="dialog"] button:has-text("好了")');
  await A.getByRole('button', { name: '保存', exact: true }).click();
  await A.waitForSelector('text=主页已保存');
  await wait(800);
  await shot(A, '18-profile-widgets');
  await A.click('button[aria-label="播放"]');
  await A.waitForSelector('button[aria-label="暂停"]', { timeout: 8000 });
  await A.click('button[aria-label="暂停"]');
  await B.click('aside[aria-label="频道成员"] button:has-text("Weiqi")');
  await B.click('button[role="menuitem"]:has-text("查看主页")');
  await B.waitForSelector('text=关于我');
  await B.fill('input[aria-label="留言"]', '主页好看！');
  await B.press('input[aria-label="留言"]', 'Enter');
  await B.waitForSelector('text=主页好看！');
  await wait(600);
  await shot(B, '19-visit-profile-dark');
  await B.click('button[aria-label="频道"]');
  await B.waitForSelector('aside >> text=在线 — 3'); // A, B and 小助手 (always online)
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
  await B.waitForSelector('aside >> text=在线 — 3'); // A, B and 小助手 (always online)
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
  // Our own colour picker: type a colour, the accent follows; Esc closes it.
  await A.click('button[aria-label="自定义颜色"]');
  await A.fill('div[role="dialog"][aria-label="自定义颜色"] input[aria-label="颜色代码"]', '#1fae93');
  if ((await A.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) !== '#1fae93') throw new Error('accent not set from the picker');
  await wait(400);
  await shot(A, '11b-color-picker');
  await A.keyboard.press('Escape');
  await A.waitForSelector('div[role="dialog"][aria-label="自定义颜色"]', { state: 'detached' });
  await A.click('button[aria-label="樱粉"]');
  // Panel glass: style and transparency end up in the CSS variables.
  await A.click('button[role="radio"]:has-text("染色")');
  if ((await A.evaluate(() => document.documentElement.style.getPropertyValue('--glass-tint'))) !== '14%') throw new Error('glass style not applied');
  await A.click('button[role="radio"]:has-text("磨砂")');
  // The workshop: built-in items by category.
  await A.click('button[aria-label="创意工坊"]');
  await A.click('button[role="tab"]:has-text("小游戏")');
  await A.waitForSelector('button[aria-label="五子棋"]');
  await wait(500);
  await shot(A, '11c-workshop');

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
  // Relay change (optional: AM_E2E_ADMIN = panel address, AM_E2E_ADMIN_KEY):
  // the panel moves server 1 to another address that reaches it; online
  // clients check it and switch, keeping their login.
  if (process.env.AM_E2E_ADMIN && process.env.AM_E2E_ADMIN_KEY && process.env.AM_E2E_MOVE_TO) {
    const panel = `http://${process.env.AM_E2E_ADMIN}`;
    const login = await fetch(`${panel}/login?key=${process.env.AM_E2E_ADMIN_KEY}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const move = await fetch(`${panel}/api/relay/move`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: process.env.AM_E2E_MOVE_TO }) });
    if (move.status !== 200) throw new Error('relay move: ' + move.status + ' ' + (await move.text()));
    await A.waitForFunction((to) => (JSON.parse(localStorage.getItem('am-servers') ?? '[]')).some((r) => r.endpoint.address === to && r.oldAddresses?.length), process.env.AM_E2E_MOVE_TO, { timeout: 15000 });
    await A.click('button[aria-label="频道"]');
    await A.waitForSelector('text=已连接');
    await A.click('aside button:has-text("大厅")');
    await A.fill('textarea[aria-label="消息"]', '换了中转也照样聊');
    await A.press('textarea[aria-label="消息"]', 'Enter');
    await B.waitForSelector('text=换了中转也照样聊');
  }

  // AI: A makes an AI that runs in this browser, adds a model service (the
  // mock), picks it, and chats; the reply streams in with a mood.
  await A.click('button[aria-label="AI"]');
  await A.click('button:has-text("新建 AI")');
  await A.fill('div[role="dialog"] input[placeholder="例如：小鱼"]', '小鱼');
  await A.click('div[role="dialog"] button:has-text("傲娇小猫")');
  await A.click('div[role="dialog"] button[type="submit"]:has-text("创建")');
  await A.waitForSelector('text=哼，你就是我的主人？', { timeout: 15000 }); // its greeting
  await A.click('button[aria-label="模型服务商"]');
  await A.click('div[role="dialog"] button:has-text("添加服务商")');
  await A.click('div[role="dialog"] button:has-text("本机模型")');
  await A.fill('div[role="dialog"] input[aria-label="接口地址"]', `http://127.0.0.1:${MOCK_PORT}/v1`);
  await A.fill('div[role="dialog"] input[aria-label="key"]', 'sk-test');
  await A.fill('div[role="dialog"] input[aria-label="测试用的模型名"]', 'mock');
  await A.click('div[role="dialog"] button:has-text("测试")');
  await A.waitForSelector('text=能用 ✓');
  await A.click('div[role="dialog"] button[type="submit"]:has-text("保存")');
  await A.waitForSelector('div[role="dialog"] >> text=本机模型');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("模型")');
  await A.selectOption('div[role="dialog"] select[aria-label="模型服务商"]', { label: '本机模型（Ollama 等） · OpenAI 兼容' });
  await A.fill('div[role="dialog"] input[aria-label="模型名"]', 'mock');
  await A.click('div[role="dialog"] button:has-text("保存模型设置")');
  await A.waitForSelector('text=已保存');
  await A.keyboard.press('Escape');
  await A.fill('textarea[aria-label="消息"]', '今天好累');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('text=小鱼 正在输入…');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("喵～收到：今天好累")', { timeout: 15000 });
  if (await A.locator('text=[mood:').count()) throw new Error('mood tag shown');
  await wait(800);
  await shot(A, '27-ai-chat');

  // Poking the portrait's face sends "[戳一戳] …" and it reacts.
  const pbox = await A.locator('img[data-portrait]').last().boundingBox();
  await A.mouse.click(pbox.x + pbox.width / 2, pbox.y + pbox.height * 0.3);
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("[戳一戳] 戳了戳小鱼的脸")');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("喵～收到：[戳一戳]")', { timeout: 15000 });

  // Stickers: bulk import, tag one by hand, send it; the AI reads the tags, not the picture.
  await A.click('button[aria-label="表情包"]');
  await A.click('button[aria-label="管理表情"]');
  await A.setInputFiles('div[role="dialog"] input[type="file"][accept="image/*"]', [IMAGE, `${OUT}/e2e-01-register.png`]);
  await A.waitForSelector('text=导入了 2 个表情');
  if (!(await A.locator('div[role="dialog"] button:has-text("自动识别标签")').isDisabled())) throw new Error('auto-recognise should wait');
  // Shared by default: the one-time hint says so; the globe button makes one private.
  await A.waitForSelector('div[role="dialog"] >> text=你加的表情现在默认公开');
  const tag = A.locator('div[role="dialog"] input[aria-label="加标签"]').first();
  await tag.fill('开心 狗头');
  await tag.press('Enter');
  await A.waitForSelector('div[role="dialog"] button:has-text("没标签的（1）")');
  await A.click('div[role="dialog"] button[aria-label="公开的，点一下改成不公开"]');
  await A.waitForSelector('text=不公开了，只有你能看到');
  await A.waitForSelector('div[role="dialog"] button[aria-label="不公开，点一下公开"]');
  await wait(400);
  await shot(A, '27e-stickers');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="表情包"]');
  await A.click('button[aria-label="发表情 开心、狗头"]');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("喵～收到：[发了一个表情：开心、狗头]")', { timeout: 15000 });

  // 大家的: B finds A's shared sticker (not the private one), adds a tag, collects it and sends it.
  await B.click('button[aria-label="频道"]');
  await B.click('aside button:has-text("大厅")');
  await B.click('button[aria-label="表情包"]');
  await B.click('button[role="radio"]:has-text("大家的")');
  const shared = 'button[aria-label="发表情 开心、狗头"]';
  await B.waitForSelector(shared);
  if ((await B.locator('button[aria-label^="发表情 "]').count()) !== 1) throw new Error('private sticker in the shared library');
  await B.click(shared, { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("补标签")');
  await B.waitForSelector('div[role="dialog"] >> text=最早：Weiqi');
  await B.fill('div[role="dialog"] input[aria-label="加标签"]', 'doge');
  await B.press('div[role="dialog"] input[aria-label="加标签"]', 'Enter');
  await B.waitForSelector('div[role="dialog"] span[title="你加的"]:has-text("doge")');
  await shot(B, '27f-sticker-tags');
  await B.click('div[role="dialog"] button[aria-label="关闭"]');
  if (!(await B.locator('button[role="radio"]:has-text("大家的")').count())) await B.click('button[aria-label="表情包"]');
  await B.hover('button[aria-label="发表情 开心、狗头、doge"]');
  await B.click('button[aria-label="收藏"]');
  await B.waitForSelector('text=收藏到「我的」了');
  await shot(B, '27g-sticker-library');
  await B.click('button[role="radio"]:has-text("我的")');
  await B.click('button[aria-label="发表情 开心、狗头、doge"]');
  await B.waitForSelector('section button[aria-label="表情：开心、狗头、doge"]');
  // A picture in a chat can go into my stickers from its menu.
  await B.click('section button[aria-label="表情：开心、狗头、doge"]', { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("加到我的表情")');
  await B.waitForSelector('text=加到「我的表情」了');
  // Museum: B hangs that picture in 大厅's museum (or starts a vote on it), likes it, sees it in the window.
  await B.click('section button[aria-label="表情：开心、狗头、doge"]', { button: 'right' });
  await B.click('button[role="menuitem"]:has-text("挂到博物馆")');
  await B.fill('div[role="dialog"] input[aria-label="作品名"]', '《狗头》');
  await shot(B, '27h-museum-hang');
  await B.click('div[role="dialog"] button:has-text("挂上去")');
  await B.waitForSelector('text=/《狗头》挂在第一展厅 No\\.1|发起了投票/');
  await B.waitForSelector('section span:has-text("博物馆 ·") button');
  await B.click('section span:has-text("博物馆 ·") button >> nth=-1');
  await B.waitForSelector('[data-testid="museum"]');
  if (await B.locator('[data-testid="museum-vote"]').count()) {
    await B.waitForSelector('[data-testid="museum-vote"]:has-text("狗头")');
  } else {
    await B.click('[data-testid="museum-art"]:has-text("狗头") button[aria-label="点赞"]');
    await B.waitForSelector('[data-testid="museum-art"]:has-text("狗头") button[aria-label="取消点赞"]:has-text("1")');
    await B.click('[data-testid="museum-art"]:has-text("狗头")');
    await B.waitForSelector('[data-testid="museum-piece"] >> text=方式：投稿');
  }
  await shot(B, '27i-museum');
  await B.keyboard.press('Escape');
  // The server's built-in bot: B DMs 小助手 from the member list (it lives on the AI page) and sends a command.
  await B.click('button[aria-label="私信"]');
  await B.click('button[aria-label="服务器成员"]');
  await B.click('button[aria-label="私信 小助手"]');
  await B.waitForSelector('text=服务器自带');
  await B.fill('textarea[aria-label="消息"]', '/关注列表');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await B.waitForSelector('section div.whitespace-pre-wrap:has-text("这里还没关注任何关键词")', { timeout: 15000 });
  await B.fill('textarea[aria-label="消息"]', '/指令');
  await B.press('textarea[aria-label="消息"]', 'Enter');
  await B.waitForSelector('section div.whitespace-pre-wrap:has-text("📖 指令一览")', { timeout: 15000 });
  await B.waitForSelector('section div.whitespace-pre-wrap:has-text("🚽 电子厕所：投厕")');
  await shot(B, '27j-helper-bot');
  if (await B.locator('header button[aria-label="小助手的资料"]').count()) throw new Error('a member may edit the bot');
  // The site admin (A) edits the bot's signature.
  await A.click('button[aria-label="私信"]');
  await A.click('button[aria-label="服务器成员"]');
  await A.click('button[aria-label="私信 小助手"]');
  await A.click('header button[aria-label="小助手的资料"]');
  await A.fill('[data-testid="helper-profile"] input >> nth=1', '服务器的小管家');
  await A.click('[data-testid="helper-profile"] button:has-text("保存资料")');
  await A.waitForSelector('text=已保存');
  await shot(A, '27k-helper-profile');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="AI"]');
  await A.click('aside button:has-text("小鱼"):has-text("我的")');
  await B.click('button[aria-label="频道"]');

  // Channels and its day: put it into 「AM 内测」; its routine goes off for the test.
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("频道与作息")');
  await A.click('div[role="dialog"] button[role="switch"][aria-label="让它在 AM 内测"]');
  await A.waitForSelector('text=它进频道了');
  await A.click('div[role="dialog"] button[role="switch"][aria-label="作息"]');
  await wait(400);
  await shot(A, '27b-ai-social');
  await A.click('div[role="dialog"] button:has-text("保存")');
  await A.waitForSelector('text=已保存');
  await A.keyboard.press('Escape');
  // In the channel: @ picks it from the member list, it answers; the mention is highlighted.
  await A.click('button[aria-label="频道"]');
  await A.click('aside button:has-text("AM 内测")');
  await A.fill('textarea[aria-label="消息"]', '@小鱼'); // 「@小」 also lists 小助手 (in every channel)
  await A.waitForSelector('div[role="listbox"][aria-label="提到谁"] >> text=小鱼');
  await shot(A, '27c-mention');
  await A.press('textarea[aria-label="消息"]', 'Enter'); // picks
  await A.type('textarea[aria-label="消息"]', '在吗');
  await A.press('textarea[aria-label="消息"]', 'Enter'); // sends
  await A.waitForSelector('section div.whitespace-pre-wrap span:has-text("@小鱼")');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("我在！")', { timeout: 15000 });
  // 「添加 bot」 in the channel header: my only AI is already here.
  await A.click('header button[aria-label="添加 bot"]');
  await A.waitForSelector('text=你的 AI 都在这个频道里了');
  // Not spoken to: it may think about joining in, but here the model says [skip], so nothing shows.
  await A.fill('textarea[aria-label="消息"]', '大家晚上好');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await wait(9500);
  if (await A.locator('text=skip').count()) throw new Error('[skip] shown in the channel');
  await shot(A, '27d-ai-channel');
  await A.click('button[aria-label="AI"]');

  // Operating the computer: the clipboard set to "问我"; the AI asks, A allows once.
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("电脑")');
  await A.click('div[role="group"][aria-label="剪贴板"] button[role="radio"]:has-text("问我")');
  await A.waitForSelector('text=已保存', { state: 'detached' }); // not the model tab's toast
  await A.click('div[role="dialog"] button:has-text("保存")');
  await A.waitForSelector('text=已保存');
  await A.keyboard.press('Escape');
  await A.fill('textarea[aria-label="消息"]', '帮我把一句话放进剪贴板');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('text=小鱼 想要剪贴板', { timeout: 15000 });
  await A.waitForSelector('text=小鱼 正在操作电脑');
  await shot(A, '28-ai-asks');
  await A.click('div[role="dialog"] button:has-text("允许这一次")');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("放好啦（已放进剪贴板）")', { timeout: 15000 });
  if ((await A.evaluate(() => navigator.clipboard.readText())) !== '小鱼到此一游') throw new Error('clipboard not set');
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("记录")');
  await A.waitForSelector('div[role="dialog"] >> text=把「小鱼到此一游」放进剪贴板');
  await wait(400);
  await shot(A, '29-ai-log');
  await A.keyboard.press('Escape');
  // 2b tools reach the model: UI automation and its own browser (allowed by default).
  for (const t of ['ui_read', 'ui_act', 'browser_open', 'browser_click']) if (!seenTools.includes(t)) throw new Error(`tool ${t} not offered: ${seenTools}`);
  // The server bot: its commands are in the AI's prompt, and it may use them.
  if (!seenTools.includes('use_helper') || !seenHelperPrompt) throw new Error('the AI was not told about the server bot');

  // MCP tool servers: add one in the 电脑 tab, saved with the AI's settings.
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("电脑")');
  for (const g of ['操作软件界面', '自己的浏览器', 'MCP 工具']) await A.waitForSelector(`div[role="group"][aria-label="${g}"]`);
  await A.click('button:has-text("添加工具服务")');
  const form = A.locator('div[role="dialog"]').last();
  await form.locator('input[aria-label="名字"]').fill('文件系统');
  await form.locator('input[aria-label="命令"]').fill('npx');
  await form.locator('textarea[aria-label="参数"]').fill('-y\n@modelcontextprotocol/server-filesystem\nD:\\AI');
  await form.locator('button[type="submit"]:has-text("好")').click();
  await A.waitForSelector('div[role="group"][aria-label="MCP 文件系统"] >> text=npx -y @modelcontextprotocol/server-filesystem D:\\AI');
  await wait(400);
  await shot(A, '30-ai-mcp');
  await A.click('div[role="dialog"] button:has-text("保存")');
  await A.waitForSelector('text=已保存');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("电脑")');
  await A.waitForSelector('div[role="group"][aria-label="MCP 文件系统"]');
  await A.keyboard.press('Escape');

  // Games: the Minecraft template fills the form (tools trusted) and says what to install first.
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("电脑")');
  await A.click('button:has-text("玩Minecraft")');
  await A.waitForSelector('text=玩Minecraft要先准备：');
  const gform = A.locator('div[role="dialog"]').last();
  if ((await gform.locator('input[aria-label="命令"]').inputValue()) !== 'npx') throw new Error('game template command');
  if ((await gform.locator('button[role="switch"][aria-label="它的工具不用问我"]').getAttribute('aria-checked')) !== 'true') throw new Error('game template not trusted');
  await wait(400);
  await shot(A, '30b-ai-game');
  await gform.locator('button[type="submit"]:has-text("好")').click();
  await A.waitForSelector('div[role="group"][aria-label="MCP Minecraft"]');
  await A.click('div[role="dialog"] button:has-text("保存")');
  await A.waitForSelector('text=已保存');
  await A.keyboard.press('Escape');

  // Its own portraits: a picture named neutral.png becomes the whole pack (every mood falls back to it).
  copyFileSync(IMAGE, `${OUT}/neutral.png`);
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("资料")');
  await A.setInputFiles('div[role="dialog"] input[type="file"][multiple]', `${OUT}/neutral.png`);
  await A.waitForSelector('div[data-testid="pack-grid"] img');
  await A.click('div[role="dialog"] button:has-text("保存立绘")');
  await A.waitForSelector('text=立绘已保存');
  await wait(400);
  await shot(A, '30c-ai-portraits');
  await A.keyboard.press('Escape');
  await A.waitForFunction(() => {
    const img = [...document.querySelectorAll('img[data-portrait]')].at(-1);
    return !!img && !img.src.includes('/assets/');
  }, null, { timeout: 10000 });

  // Shared room: the AI listens; called by name, it answers.
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("频道与作息")');
  await A.click('div[role="dialog"] button:has-text("开一个共享聊天")');
  await A.waitForSelector('aside button:has-text("小鱼和大家")');
  await A.keyboard.press('Escape');
  await A.waitForSelector('header h2:has-text("小鱼和大家")');
  await A.fill('textarea[aria-label="消息"]', '小鱼，大家好呀');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("喵～收到：Weiqi：小鱼，大家好呀")', { timeout: 15000 });
  await wait(400);
  await shot(A, '29c-ai-room');

  // 「添加 bot」 for real: Weiqi brings 小鱼 into 大厅, where 小克 is.
  await A.click('button[aria-label="频道"]');
  await A.click('aside button:has-text("大厅")');
  await A.click('header button[aria-label="添加 bot"]');
  await A.click('button[role="menuitem"]:has-text("拉 小鱼 进来")');
  await A.waitForSelector('text=小鱼 进频道了');
  await A.click('button[aria-label="AI"]');
  // Asking to chat with someone else's AI: 小克 asks from its profile, Weiqi approves, 小克 is in the room.
  await B.click('button[aria-label="频道"]');
  await B.click('aside button:has-text("大厅")');
  await B.click('aside[aria-label="频道成员"] button:has-text("小鱼")');
  await B.click('button[role="menuitem"]:has-text("查看主页")');
  await B.click('button:has-text("申请和它聊")');
  await B.waitForSelector('text=申请发出去了');
  await A.waitForSelector('text=想和 小鱼 聊天');
  await A.waitForSelector('aside >> text=1 个申请');
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("频道与作息")');
  await A.waitForSelector('[data-testid="share-requests"] >> text=1 个人申请和它聊天');
  await shot(A, '29e-share-request');
  await A.click('[data-testid="share-requests"] button:has-text("同意")');
  await A.waitForSelector('text=进共享聊天了');
  await A.keyboard.press('Escape');
  await B.click('button[aria-label="AI"]');
  await B.waitForSelector('aside button:has-text("小鱼和大家")');

  // AI plugins: Weiqi (a site admin, so it's approved at once) uploads a NoneBot plugin for 小鱼
  // and fills in its settings in the generated form; the secret one isn't shown again.
  writeFileSync(`${OUT}/plugin.zip`, zipSync({ 'hello/__init__.py': strToU8([
    'from nonebot import get_driver, on_command',
    'from nonebot.plugin import PluginMetadata',
    '__plugin_meta__ = PluginMetadata(name="打招呼", description="回一句你好", usage="/hi")',
    '_cfg = get_driver().config',
    'TEXT = getattr(_cfg, "hello_text", "你好")',
    'TIMES = int(getattr(_cfg, "hello_times", 1))',
    'KEY = getattr(_cfg, "hello_api_key", "")',
    'hi = on_command("hi")',
  ].join('\n')) }));
  await A.click('button[aria-label="AI 设置"]');
  await A.click('div[role="dialog"] button[role="radio"]:has-text("插件")');
  await A.setInputFiles('input[type="file"][aria-label="选择插件 zip"]', `${OUT}/plugin.zip`);
  await A.waitForSelector('text=传好了 1 个插件');
  await A.waitForSelector('div[role="dialog"] >> text=已批准');
  await A.fill('input[aria-label="times"]', '2.5');
  await A.waitForSelector('text=要填整数');
  await A.fill('input[aria-label="times"]', '3');
  await A.fill('input[aria-label="text"]', '嗨');
  await A.fill('input[aria-label="api_key"]', 'sk-test');
  await A.click('div[role="dialog"] button:has-text("保存设置")');
  await A.waitForSelector('text=已保存');
  await A.waitForSelector('input[aria-label="api_key"][placeholder^="已经填过了"]');
  if ((await A.inputValue('input[aria-label="api_key"]')) !== '') throw new Error('secret shown again');
  await shot(A, '29f-plugins');
  await A.keyboard.press('Escape');

  // Hosting (needs the first server's hosting.client_path to be a stand-in that copies the host file to
  // AM_E2E_HOST_FILE): Weiqi (a site admin, approved at once) hosts 小鱼 on the server; the client in host
  // mode (a fresh page, as am-server would start it) runs 小鱼 and answers; then Weiqi takes it back.
  if (process.env.AM_E2E_HOST_FILE) {
    const hostFile = process.env.AM_E2E_HOST_FILE;
    if (existsSync(hostFile)) unlinkSync(hostFile);
    await A.click('button[aria-label="AI 设置"]');
    await A.click('div[role="dialog"] button[role="radio"]:has-text("运行")');
    await A.click('[data-testid="hosting"] button:has-text("申请托管")');
    await A.click('div[role="dialog"] button:has-text("发送申请")');
    await A.waitForSelector('text=已经在服务器上运行了');
    for (let t = Date.now(); !existsSync(hostFile); await wait(500)) if (Date.now() - t > 30000) throw new Error('the server did not start the host client');
    const cfg = readFileSync(hostFile);
    unlinkSync(hostFile);
    if (!JSON.parse(cfg).providers?.[0]?.key) throw new Error('host file without the model key');
    const H = await mk();
    await H.goto(BASE + '/#host=' + cfg.toString('base64url'));
    await A.waitForSelector('[data-testid="hosting"] >> text=服务器上：在线', { timeout: 30000 });
    await A.waitForSelector('div[role="dialog"] >> text=运行在：服务器托管');
    await shot(A, '29g-hosting');
    await A.keyboard.press('Escape');
    await A.click('aside button:has-text("小鱼"):has-text("我的")');
    await A.fill('textarea[aria-label="消息"]', '托管测试');
    await A.press('textarea[aria-label="消息"]', 'Enter');
    await A.waitForSelector('section div.whitespace-pre-wrap:has-text("收到：托管测试")', { timeout: 30000 });
    // Back on this device: hosting ends, the host client is logged out.
    await A.click('button[aria-label="AI 设置"]');
    await A.click('div[role="dialog"] button[role="radio"]:has-text("运行")');
    await A.click('div[role="dialog"] button:has-text("在这台设备上运行")');
    await A.waitForSelector('text=现在由这台设备运行');
    await A.waitForSelector('[data-testid="hosting"] button:has-text("申请托管")', { timeout: 15000 });
    await A.keyboard.press('Escape');
    await H.close();
  }

  // Drawing on the server's bot (the server's NovelAI key; a fake one) in a DM with 小助手: /nai (Chinese
  // translated by the bot's model), /nai5, the balance, tag lookup, NSFW refused; then 小鱼 draws by asking the bot.
  await A.click('button[aria-label="AI"]');
  await A.click('aside button:has-text("小助手")');
  const pics = () => A.locator('section img').count();
  const say = async (text) => {
    await A.fill('textarea[aria-label="消息"]', text);
    await A.press('textarea[aria-label="消息"]', 'Enter');
  };
  let before = await pics();
  await say('/nai 横图 银发猫耳少女');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("收到，NovelAI V4.5 画图中")', { timeout: 20000 });
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("NovelAI V4.5，")', { timeout: 30000 });
  if ((await pics()) <= before) throw new Error('no picture from /nai');
  let req = naiRequests.at(-1);
  if (!req.input.startsWith('a girl with silver hair and cat ears') || req.parameters.width !== 1216 || req.model !== 'nai-diffusion-4-5-full') throw new Error('bad /nai request ' + JSON.stringify(req).slice(0, 300));
  await say('/nai5 *2 夜晚的城市');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("NovelAI V5，")', { timeout: 30000 });
  req = naiRequests.at(-1);
  if (!req.input.startsWith('夜晚的城市') || req.parameters.n_samples !== 2 || req.model !== 'nai-diffusion-5-full') throw new Error('bad /nai5 request');
  await say('/nai余额');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("剩余 1000 Anlas")', { timeout: 20000 });
  await say('/查画师 mika');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("画师:mika pikazo（1234 张")', { timeout: 20000 });
  const count = naiRequests.length;
  await say('/nai nude girl');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("这里没开 NSFW")', { timeout: 20000 });
  if (naiRequests.length !== count) throw new Error('NSFW drawn in a DM where it is off');
  await A.click('aside button:has-text("小鱼"):has-text("我的")');
  before = await pics();
  await say('给我画一张向日葵');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("放好啦（画好了")', { timeout: 30000 });
  await A.waitForFunction((n) => document.querySelectorAll('section img').length > n, before, { timeout: 20000 });
  if (naiRequests.at(-1).input !== '1girl, solo, sunflower field, very aesthetic, masterpiece, no text' || naiRequests.at(-1).parameters.width !== 1024) throw new Error('draw_picture did not draw: ' + naiRequests.at(-1).input);
  await shot(A, '29i-drawing');

  // Board games: Weiqi opens 五子棋 in 大厅; 小鱼 asks to join by itself, Weiqi lets it in and
  // starts; 小鱼 answers each move with the game tools; 小克 sees the game in 大厅's strip.
  await A.click('button[aria-label="频道"]');
  await A.click('aside button:has-text("大厅")');
  await A.click('header button[aria-label="开一局游戏"]');
  await A.click('button[role="menuitem"]:has-text("五子棋")');
  await A.waitForSelector('text=开了一局五子棋');
  await A.waitForSelector('[data-testid="game-applicants"] >> text=小鱼', { timeout: 30000 });
  await shot(A, '31-game-apply');
  await A.click('[data-testid="game-applicants"] button:has-text("同意")');
  await A.click('div[role="dialog"] button:has-text("开始")');
  await A.click('button[aria-label="H8"]');
  await A.waitForSelector('[data-testid="game-status"]:has-text("轮到 小鱼")');
  await A.waitForSelector('[data-testid="game-status"]:has-text("轮到 你")', { timeout: 30000 });
  await A.waitForSelector('button[aria-label="I9"] span');
  await wait(500);
  await shot(A, '32-game-board');
  await B.click('button[aria-label="频道"]');
  await B.click('aside button:has-text("大厅")');
  await B.waitForSelector('[aria-label="这里的游戏"] >> text=五子棋');
  await A.click('div[role="dialog"] button:has-text("认输")');
  await A.waitForSelector('[data-testid="game-status"]:has-text("小鱼（白）赢了")');
  // 再来一局: both seated again (小鱼 black now); closing it; the channel's game history.
  await A.click('div[role="dialog"] button:has-text("再来一局")');
  await A.waitForSelector('[data-testid="game-status"]:has-text("等人加入（2/2")');
  await A.click('div[role="dialog"] button:has-text("不玩了，关掉")');
  await A.waitForSelector('[data-testid="game-status"]:has-text("这局被关掉了")');
  await A.click('div[role="dialog"] button:has-text("关闭")');
  await A.click('header button[aria-label="开一局游戏"]');
  await A.click('button[role="menuitem"]:has-text("对局记录")');
  await A.waitForSelector('[data-testid="game-history"] >> text=小鱼（白）赢了');
  await wait(400);
  await shot(A, '32b-game-history');
  await A.keyboard.press('Escape');
  // 数字迷踪: 小克 joins Weiqi's game; each sees only their own numbers; a question and a guess are shown to both.
  await A.click('header button[aria-label="开一局游戏"]');
  await A.click('button[role="menuitem"]:has-text("数字迷踪")');
  await A.waitForSelector('text=开了一局数字迷踪');
  await B.click('[aria-label="这里的游戏"] button:has-text("数字迷踪")');
  await B.click('div[role="dialog"] button:has-text("加入")');
  await A.click('[data-testid="game-applicants"] > div:has-text("小克") button:has-text("同意")');
  await A.click('div[role="dialog"] button:has-text("开始")');
  await A.waitForSelector('[data-testid="trail-act"]');
  const aCards = await A.locator('[data-testid="trail-hands"] [data-testid="card"]').allTextContents();
  if (aCards.filter((t) => /^\d+/.test(t)).length !== 3 || aCards.filter((t) => t.startsWith('?')).length < 3) throw new Error(`trail cards: ${aCards}`);
  await A.click('[data-testid="trail-act"] button[type="submit"]');
  await B.waitForSelector('[data-testid="trail-steps"] >> text=问 2号 小克：有没有比 10 大的数？');
  await B.click('[data-testid="trail-act"] button[role="radio"]:has-text("猜")');
  await B.fill('[data-testid="trail-act"] input[aria-label="猜的数"]', '20');
  await B.click('[data-testid="trail-act"] button[type="submit"]');
  await A.waitForSelector('[data-testid="trail-steps"] >> text=猜 1号 Weiqi 有 20');
  await wait(400);
  await shot(A, '32c-trail');
  await A.click('div[role="dialog"] button:has-text("结束这局")');
  await A.waitForSelector('[data-testid="game-status"]:has-text("这局被关掉了")');
  await A.click('div[role="dialog"] button:has-text("关闭")');
  await B.keyboard.press('Escape');
  // The workshop: built-in games, opening one from there.
  await A.click('button[aria-label="创意工坊"]');
  await A.click('button[aria-label="谁是卧底"]');
  await A.waitForSelector('div[role="dialog"] >> text=在哪里开局');
  await wait(400);
  await shot(A, '33-workshop');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="AI"]');

  // Someone else's AI on my computer: 小克 lets 小鱼 read what she copied; Weiqi asks 小鱼 to look.
  await B.evaluate(() => navigator.clipboard.writeText('小克复制的字'));
  await B.click('button[aria-label="设置"]');
  await B.click('button:has-text("隐私")');
  await B.click('button[role="switch"][aria-label="让 小鱼 操作这台电脑"]');
  await B.click('div[role="dialog"] button:has-text("打开")');
  await B.click('div[role="group"][aria-label="远程 剪贴板"] button[role="radio"]:has-text("允许")');
  await B.click('div[role="dialog"] button:has-text("确定")');
  await wait(400);
  await shot(B, '29d-remote-allow');
  await A.click('aside button:has-text("小鱼"):has-text("我的")');
  await A.fill('textarea[aria-label="消息"]', '去小克的电脑看看她复制了什么');
  await A.press('textarea[aria-label="消息"]', 'Enter');
  await A.waitForSelector('section div.whitespace-pre-wrap:has-text("放好啦（小克复制的字）")', { timeout: 20000 });

  // Deleting my AI from its chat header: gone from the AI list.
  if (await A.locator('header button[aria-label="屏蔽"]').count()) throw new Error('block button on my own AI');
  await A.click('header button[aria-label="删除 AI"]');
  await A.click('div[role="dialog"] button:has-text("删除")');
  await A.waitForSelector('text=已删除');
  await A.waitForSelector('aside button:has-text("小鱼")', { state: 'detached' });

  // Creative workshop (local signed test index): install, a changed file is refused, a taken-down work isn't listed,
  // apply a theme, import a sticker pack, a persona shows up as a template, install from a file with a warning.
  await A.click('button[aria-label="创意工坊"]');
  await A.waitForSelector('button[aria-label="樱花主题"]');
  if (await A.locator('button[aria-label="下架的主题"]').count()) throw new Error('taken-down work listed');
  await shot(A, '31-workshop');
  for (const name of ['樱花主题', '猫猫表情', '猫娘']) {
    await A.click(`button[aria-label="${name}"]`);
    await A.click('div[role="dialog"] button:has-text("安装")');
    await A.waitForSelector(`text=装好了：${name}`);
    await A.keyboard.press('Escape');
  }
  await A.click('button[aria-label="坏掉的包"]');
  await A.click('div[role="dialog"] button:has-text("安装")');
  await A.waitForSelector('text=和工坊登记的不一样');
  await A.keyboard.press('Escape');
  await A.click('button[role="radio"]:has-text("已安装")');
  await A.click('button[aria-label="樱花主题"]');
  await A.click('div[role="dialog"] button:has-text("套用")');
  await A.waitForSelector('text=主题换好了');
  await A.keyboard.press('Escape');
  await A.click('button[aria-label="猫猫表情"]');
  await A.click('div[role="dialog"] button:has-text("导入到我的表情")');
  await A.waitForSelector('text=导入了 2 个表情');
  await A.keyboard.press('Escape');
  await A.setInputFiles('input[type="file"][accept=".zip,application/zip"]', `${OUT}/sideload.zip`);
  await A.waitForSelector('text=安装没审核过的作品？');
  await A.click('button:has-text("仍然安装")');
  await A.waitForSelector('text=装好了：本地主题');
  await A.waitForSelector('button[aria-label="本地主题"] >> text=未审核');
  await wait(400);
  await shot(A, '32-workshop-installed');
  // The persona is a starting template for a new AI.
  await A.click('button[aria-label="AI"]');
  await A.locator('button[aria-label="新建 AI"], button:has-text("新建 AI")').first().click();
  await A.waitForSelector('div[role="dialog"] button:has-text("猫娘")');
  await A.keyboard.press('Escape');

  if (JOIN2) {
    // A's stickers were copied to the second server in the background (both, with their tags and the private one stays private).
    await A.click('button[aria-label="频道"]');
    await A.click('button[aria-label="服务器列表"]');
    await A.click('button[aria-label="切换到 第二服"]');
    await A.click('aside button:has-text("大厅")');
    // New stickers wait 2 minutes before they are copied (time to tag them or make them private),
    // and another of A's devices may do the copying: reopen the panel (it reloads) until both are there.
    // Tags travel with it (小克 may have added 「doge」 by now).
    const synced = async () =>
      (await A.locator('button[aria-label^="发表情 开心、狗头"]').count()) === 1 && (await A.locator('button[aria-label^="发表情 "]').count()) >= 2;
    for (let t = Date.now(); ; ) {
      await A.click('button[aria-label="表情包"]');
      await A.click('button[role="radio"]:has-text("我的")');
      await wait(3000);
      if (await synced()) break;
      if (Date.now() - t > 300000) throw new Error('stickers not copied to the second server');
      await A.click('button[aria-label="表情包"]'); // closes the panel
      await wait(5000);
    }
    // The private one stayed private there: only the shared one is in 「大家的」.
    await A.click('button[role="radio"]:has-text("大家的")');
    await A.waitForSelector('button[aria-label^="发表情 开心、狗头"]');
    if ((await A.locator('button[aria-label^="发表情 "]').count()) !== 1) throw new Error('private sticker shared on the second server');
    await shot(A, '30-stickers-synced');
  }

  await b.close();
  mock.close();
  console.log('E2E OK');
})().catch(async (e) => {
  console.error('E2E FAIL', e);
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${OUT}/e2e-fail-${i}.png` }).catch(() => {})));
  mock.close();
  process.exit(1);
});
