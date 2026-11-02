// AM server admin panel. Plain JavaScript, no build step: it is embedded in
// am-server.exe. All text from the server goes through text nodes (el()),
// never innerHTML, because user names are user input.
'use strict';

// ---------- small helpers ----------

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const ERR_TEXT = {
  not_running: '服务器没有在运行',
  reason_required: '请填写原因',
  user_not_found: '找不到这个用户',
  not_found: '找不到，可能已经被删掉了',
  no_password: '这个账号不用密码登录',
  media_not_found: '文件不存在或已被清理',
  not_image: '这不是支持的图片（JPEG / PNG / GIF / WebP）',
  bad_image: '图片读不出来，或者像素太大',
  too_large: '图片太大了（最多 2 MB）',
};

class ApiError extends Error {
  constructor(code, message) { super(ERR_TEXT[code] || message || code); this.code = code; }
}

async function api(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch('api/' + path, opt);
  } catch (e) {
    throw new ApiError('offline', '连不上 am-server，它可能已经退出了');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') {
    showLogin();
    throw new ApiError('unauthorized', '请先登录');
  }
  if (!res.ok) throw new ApiError(data.code, data.message);
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isErr ? 5000 : 2500);
}
const fail = (e) => toast(e.message || String(e), true);

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el('textarea', { class: 'mono' }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('已复制' + (what || ''));
}

const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
  const md = d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function fmtAgo(ms) {
  if (!ms) return '从未';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
  return fmtDate(ms);
}
function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  if (h < 48) return h + ' 小时 ' + (m % 60) + ' 分';
  return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');
const groupCode = (c) => c.replace(/(.{4})(?=.)/g, '$1 ');

// ---------- dialogs ----------

function dialog(build, cls = '') {
  return new Promise((resolve) => {
    const d = el('dialog', cls ? { class: cls } : {});
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    d.append(...build(close));
    document.body.append(d);
    d.showModal();
    const first = d.querySelector('input, textarea, .btn.primary');
    if (first) first.focus();
  });
}

function confirmDialog({ title, text, ok = '确定', danger = false }) {
  return dialog((close) => [
    el('h2', {}, title),
    el('div', { class: 'body' }, el('p', {}, text)),
    el('div', { class: 'foot' },
      el('button', { class: 'btn', onclick: () => close(false) }, '取消'),
      el('button', { class: 'btn primary' + (danger ? ' danger-fill' : ''), onclick: () => close(true) }, ok)),
  ]);
}

function promptDialog({ title, text, label, placeholder = '', ok = '确定', required = true }) {
  return dialog((close) => {
    const input = el('input', { type: 'text', placeholder, maxlength: 200 });
    const submit = (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (required && !v) { input.focus(); return; }
      close(v);
    };
    return [el('form', { onsubmit: submit },
      el('h2', {}, title),
      el('div', { class: 'body' }, text && el('p', { class: 'muted' }, text), el('label', {}, el('div', { class: 'field-label' }, label), input)),
      el('div', { class: 'foot' },
        el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '取消'),
        el('button', { class: 'btn primary', type: 'submit' }, ok)))];
  });
}

function infoDialog(title, ...body) {
  return dialog((close) => [
    el('h2', {}, title),
    el('div', { class: 'body' }, body),
    el('div', { class: 'foot' }, el('button', { class: 'btn primary', onclick: () => close(true) }, '知道了')),
  ]);
}

// ---------- app state ----------

let status = null;          // last /api/status
let statusTimer = null;
let currentPage = null;
const main = () => document.querySelector('.main');

const PAGES = [
  { id: 'overview', name: '概览', render: renderOverview },
  { id: 'users', name: '用户', render: renderUsers },
  { id: 'invites', name: '邀请码', render: renderInvites },
  { id: 'channels', name: '频道记录', render: renderChannels },
  { id: 'evidence', name: '删除记录', render: renderEvidence },
  { id: 'stickers', name: '表情库', render: renderStickers },
  { id: 'plugins', name: '插件', render: renderPlugins },
  { id: 'hosting', name: 'AI 托管', render: renderHosting },
  { id: 'audit', name: '操作记录', render: renderAudit },
  { id: 'logs', name: '运行日志', render: renderLogs },
  { id: 'settings', name: '设置', render: renderSettings },
];

const STATE_TEXT = { running: '运行中', starting: '启动中', stopped: '已停止', error: '出错了' };

function showLogin() {
  clearInterval(statusTimer);
  statusTimer = null;
  const input = el('input', { type: 'password', placeholder: '登录密钥', autocomplete: 'current-password' });
  const msg = el('p', { class: 'hint' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', 'login', { key: input.value });
      start();
    } catch (err) {
      msg.textContent = err.message;
      input.select();
    }
  };
  document.getElementById('app').replaceChildren(el('div', { class: 'login' },
    el('div', { class: 'panel' },
      el('img', { src: 'favicon.png', alt: '' }),
      el('h1', {}, 'AM 服务器管理面板'),
      el('p', { class: 'muted' }, '从任务栏右下角的 AM 图标打开面板会自动登录。也可以在服务器的 data 文件夹里打开 admin_key.txt，把里面的密钥粘贴到这里。'),
      el('form', { onsubmit: submit }, input, el('button', { class: 'btn primary', type: 'submit' }, '登录'), msg))));
  input.focus();
}

async function start() {
  try {
    status = await api('GET', 'status');
  } catch (e) {
    if (e.code !== 'unauthorized') {
      document.getElementById('app').replaceChildren(el('p', { class: 'boot' }, e.message));
    }
    return;
  }
  buildShell();
  route();
  clearInterval(statusTimer);
  statusTimer = setInterval(refreshStatus, 5000);
}

function buildShell() {
  const nav = el('nav', { class: 'nav', 'aria-label': '页面' },
    PAGES.map((p) => el('a', { href: '#/' + p.id, 'data-page': p.id }, el('span', {}, p.name), el('span', { class: 'count' }))));
  document.getElementById('app').replaceChildren(el('div', { class: 'shell' },
    el('aside', { class: 'side' },
      el('div', { class: 'brand' }, el('img', { src: 'favicon.png', alt: '' }),
        el('div', {}, el('b', { id: 'brand-name' }), el('span', {}, '服务器管理'))),
      nav,
      el('div', { class: 'side-foot' },
        el('div', { class: 'state' }, el('span', { class: 'dot', id: 'state-dot' }), el('span', { id: 'state-text' })),
        el('small', { id: 'state-sub' }),
        el('button', { class: 'btn', onclick: restartServer }, '重启服务器'))),
    el('main', { class: 'main' })));
  updateChrome();
}

function updateChrome() {
  if (!status) return;
  const s = status;
  document.getElementById('brand-name').textContent = s.server_name || 'AM 服务器';
  document.getElementById('state-dot').className = 'dot ' + s.state;
  document.getElementById('state-text').textContent = STATE_TEXT[s.state] || s.state;
  document.getElementById('state-sub').textContent = s.state === 'running'
    ? '已运行 ' + fmtDuration(Date.now() - s.started_at) + '，' + (s.online_users || 0) + ' 人在线'
    : (s.version ? '版本 ' + s.version : '');
  const userCount = document.querySelector('[data-page=users] .count');
  if (userCount) userCount.textContent = s.stats ? s.stats.users : '';
  const evCount = document.querySelector('[data-page=evidence] .count');
  if (evCount) evCount.textContent = s.stats && s.stats.evidence ? s.stats.evidence : '';
  const hoCount = document.querySelector('[data-page=hosting] .count');
  if (hoCount) hoCount.textContent = s.stats && s.stats.hosting_pending ? s.stats.hosting_pending + ' 待审' : '';
  document.title = (s.server_name || 'AM 服务器') + ' - 管理面板';
}

async function refreshStatus() {
  try {
    const prev = status;
    status = await api('GET', 'status');
    updateChrome();
    const changed = !prev || prev.state !== status.state || prev.config_changed !== status.config_changed ||
      JSON.stringify(prev.stats) !== JSON.stringify(status.stats) || prev.online_users !== status.online_users;
    if (changed && currentPage && currentPage.onStatus) currentPage.onStatus();
  } catch { /* shown when the user does something */ }
}

function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('on', a.dataset.page === page.id);
    if (a.dataset.page === page.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (currentPage && currentPage.leave) currentPage.leave();
  currentPage = { id: page.id };
  main().replaceChildren();
  page.render(main(), currentPage);
}
window.addEventListener('hashchange', () => { if (status) route(); });

// Banner shown on every page when settings were saved but not applied, or
// the server is not running.
function stateBanner() {
  if (!status) return null;
  if (status.state === 'error') {
    return el('div', { class: 'banner err', role: 'alert' },
      el('p', {}, el('b', {}, '服务器没有启动成功。'), ' ', status.error),
      el('a', { class: 'btn small', href: '#/settings' }, '去改设置'),
      el('button', { class: 'btn small primary', onclick: restartServer }, '重试'));
  }
  if (status.config_changed) {
    return el('div', { class: 'banner', role: 'status' },
      el('p', {}, '设置已经改了，重启服务器后才会生效。重启时在线的人会断开几秒再自动连上。'),
      el('button', { class: 'btn small primary', onclick: restartServer }, '现在重启'));
  }
  return null;
}

function head(title, desc, ...right) {
  return el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, title), desc && el('p', {}, desc)),
    right.length ? el('div', { class: 'row' }, right) : null);
}

async function restartServer() {
  const before = status && status.started_at;
  const ov = el('div', { class: 'overlay', role: 'alert' }, '正在重启服务器…');
  document.body.append(ov);
  try {
    await api('POST', 'restart');
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        const s = await api('GET', 'status');
        if (s.state === 'error' || (s.state === 'running' && s.started_at !== before)) {
          status = s;
          break;
        }
      } catch { /* restarting */ }
    }
    updateChrome();
    if (status.state === 'running') toast('已重启'); else toast('重启后没能启动，看看提示', true);
    route();
  } catch (e) {
    fail(e);
  } finally {
    ov.remove();
  }
}

// ---------- overview ----------

let overviewAddr = 0; // selected address in the ticket

async function renderOverview(root, page) {
  page.onStatus = () => { if (currentPage === page) route(); };
  root.append(stateBanner() || '');
  if (status.state !== 'running') {
    root.append(head('概览', null), el('div', { class: 'panel' },
      el('p', { class: 'muted' }, status.state === 'starting' ? '服务器正在启动…' : '服务器现在没有运行，上面有原因。改好设置后点「重试」。')));
    return;
  }
  let conn;
  try { conn = await api('GET', 'connect'); } catch (e) { fail(e); return; }
  if (currentPage !== page) return;

  const s = status;
  const users = s.stats.users;
  const bootstrap = conn.bootstrap;
  const addrs = [...(conn.public ? [conn.public] : []), ...conn.lan];
  if (overviewAddr >= addrs.length) overviewAddr = 0;
  const entry = addrs[overviewAddr];
  const code = bootstrap ? entry.join_code : entry.server_code;

  root.append(head('概览', bootstrap ? '服务器已经跑起来了。先用下面的加入码注册你自己的账号。' : null));

  // The ticket. Before anyone registered: the admin's join code. After:
  // the server code (log in on a new device); invites live in the clients.
  const inviteText = () => [
    '来 AM 找我聊天！',
    '1. 下载 AM 客户端：' + (entry.join_url.startsWith('http') ? entry.join_url.split('#')[0] : 'https://github.com/OzakiJUN/AM/releases/latest'),
    '2. 打开客户端，粘贴加入码（或扫二维码）注册：',
    code,
  ].join('\n');

  const qr = el('img', { src: 'api/connect/qr.png?text=' + encodeURIComponent(entry.join_url), alt: '加入码二维码' });
  const ticket = el('section', { class: 'ticket', 'aria-label': bootstrap ? '注册站点管理员' : '服务器码' },
    el('div', { class: 'stub' }, qr, el('p', { class: 'cap' }, bootstrap ? 'AM 客户端扫码注册' : 'AM 客户端扫码添加服务器')),
    el('div', { class: 'body' },
      el('div', { class: 'title' },
        el('h2', {}, bootstrap ? '注册站点管理员' : '「' + (conn.name || 'AM 服务器') + '」的服务器码'),
        el('p', {}, bootstrap
          ? '在客户端里粘贴这个加入码（或扫二维码）注册。里面已经带了服务器地址和邀请码，第一个注册的账号是站点管理员，只能用一次。'
          : '已经有账号的人在新设备上用它添加服务器后登录。邀请新朋友不用这个：每个账号注册后自动有 ' + conn.per_user +
            ' 个邀请，在客户端里把加入码或二维码发给朋友就行。')),
      addrs.length > 1 && el('div', {},
        el('div', { class: 'field-label' }, '从哪里连'),
        el('div', { class: 'seg', role: 'tablist' }, addrs.map((a, i) => el('button', {
          class: i === overviewAddr ? 'on' : '', role: 'tab', 'aria-selected': String(i === overviewAddr),
          onclick: () => { overviewAddr = i; route(); },
        }, a.label + ' ' + a.address)))),
      el('div', {},
        el('div', { class: 'field-label' }, bootstrap ? '管理员加入码' : '服务器码'),
        el('div', { class: 'code-line' }, el('code', { title: code }, code),
          el('button', { class: 'btn small', onclick: () => copy(code, bootstrap ? '加入码' : '服务器码') }, '复制'))),
      el('div', { class: 'row' },
        bootstrap && el('button', { class: 'btn primary', onclick: () => copy(inviteText(), '注册说明') }, '复制注册说明'),
        el('a', { class: 'btn', href: qr.src, download: bootstrap ? 'am-admin-join.png' : 'am-server-code.png' }, '保存二维码')),
      !conn.public && addressFixer()));
  root.append(ticket);

  // Live numbers, plain.
  root.append(el('dl', { class: 'facts' },
    fact('在线', (s.online_users || 0) + ' 人'),
    fact('用户', fmtNum(users)),
    fact('群聊', fmtNum(s.stats.groups)),
    fact('消息', fmtNum(s.stats.messages)),
    fact('文件占用', fmtBytes(s.stats.media_bytes)),
    fact('已运行', fmtDuration(Date.now() - s.started_at))));

  // First-run checklist, only until it is done.
  const steps = [
    { done: !!conn.public, text: '填写公网地址，让外面的朋友能连进来（只在局域网里玩可以跳过）' },
    { done: users > 0, text: '用管理员加入码注册你自己的账号' },
    { done: users > 1, text: '在客户端里把你的加入码发给朋友' },
  ];
  if (steps.some((x) => !x.done)) {
    root.append(el('section', { class: 'panel', 'aria-label': '开始使用' },
      el('h2', {}, '开始使用'),
      el('ol', { class: 'steps' }, steps.map((x) => el('li', { class: x.done ? 'done' : '' }, x.text)))));
  }

  const tlsText = { self_signed: '自签证书（加入码里带指纹，客户端会核对）', files: '证书文件', off: '未加密，只能本机测试用' };
  root.append(el('section', { class: 'panel', 'aria-label': '服务器信息' },
    el('h2', {}, '服务器信息'),
    el('dl', { class: 'info' },
      info('监听地址', s.listen),
      info('公网地址', conn.public ? conn.public.address : '未填写'),
      info('加密', tlsText[s.tls_mode] || s.tls_mode),
      s.fingerprint && info('证书指纹', el('code', {}, s.fingerprint)),
      info('数据库', s.database === 'sqlite' ? 'SQLite（单文件，免安装）' : 'PostgreSQL'),
      info('数据文件夹', el('code', {}, s.data_dir)),
      info('配置文件', el('code', {}, s.config_path)),
      info('版本', s.version))));
  if (conn.public) root.append(await relayPanel(page));
}

// Changing the relay (public) address: check the new one reaches this
// server, then switch; online clients follow by themselves.
async function relayPanel(page) {
  let r;
  try { r = await api('GET', 'relay'); } catch (e) { return el('section', { class: 'panel' }, el('p', { class: 'muted' }, '读不到中转信息：' + e.message)); }
  const input = el('input', { type: 'text', placeholder: '新地址，例如 47.1.2.3:7000', 'aria-label': '新的中转地址' });
  const result = el('p', { class: 'hint', 'aria-live': 'polite' });
  const value = () => input.value.trim();
  const check = async (btn) => {
    if (!value()) { input.focus(); return false; }
    btn.disabled = true;
    result.textContent = '正在通过新地址连本服务器…';
    try {
      await api('POST', 'relay/test', { address: value() });
      result.textContent = '✓ 新地址能连到本服务器。';
      return true;
    } catch (e) {
      result.textContent = '✗ ' + e.message;
      return false;
    } finally { btn.disabled = false; }
  };
  const testBtn = el('button', { class: 'btn', type: 'button', onclick: (e) => check(e.currentTarget) }, '检查');
  const moveBtn = el('button', { class: 'btn primary', type: 'button', onclick: async (e) => {
    const btn = e.currentTarget;
    if (!(await check(btn))) return;
    const ok = await confirmDialog({
      title: '换成新的中转地址？',
      text: '在线的客户端会先试着连新地址，连上了才切过去。旧中转先别关：等下面「还在用旧地址的设备」变成 0 再关。以后发出的加入码都用新地址。',
      ok: '更换',
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      await api('POST', 'relay/move', { address: value() });
      toast('已换成新地址，正在通知客户端');
      await refreshStatus();
      if (currentPage === page) route();
    } catch (err) { fail(err); } finally { btn.disabled = false; }
  } }, '更换并通知客户端');
  const others = r.connections.filter((c) => c.address && c.address !== r.current);
  const oldCount = others.reduce((n, c) => n + c.devices, 0);
  return el('section', { class: 'panel', 'aria-label': '中转地址' },
    el('h2', {}, '中转地址'),
    el('p', { class: 'hint' }, '换中转服务器（frp）时用：先把新中转配好，在这里填新地址。服务器会先检查新地址是不是连到自己，再通知所有在线的客户端切过去。'),
    el('dl', { class: 'info' },
      info('现在的地址', el('code', {}, r.current)),
      info('还在用旧地址的设备', oldCount ? others.map((c) => c.address + '：' + c.devices + ' 台').join('，') : '没有'),
      r.previous && r.previous.length ? info('以前用过', r.previous.join('，')) : null),
    el('div', { class: 'row' }, input, testBtn, moveBtn),
    result);
}

function fact(k, v) { return el('div', {}, el('dt', {}, k), el('dd', {}, v)); }
function info(k, v) { return [el('dt', {}, k), el('dd', {}, v)]; }

// Inline form to set server.public_address right from the ticket.
function addressFixer() {
  const input = el('input', { type: 'text', placeholder: '例如 47.1.2.3:7000', 'aria-label': '公网地址' });
  const save = async (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    try {
      await api('PUT', 'settings', { values: { 'server.public_address': v } });
      toast('公网地址已保存');
      overviewAddr = 0;
      await refreshStatus();
      route();
    } catch (err) { fail(err); }
  };
  return el('form', { class: 'addr-fix', onsubmit: save },
    el('p', { class: 'hint' }, '朋友不在同一个网络里？填上公网地址（IP 或域名加端口；用 frp 就填中转服务器的 IP 和远程端口）。填了之后，客户端里的邀请才会带上这个地址。'),
    el('div', { class: 'row' }, input, el('button', { class: 'btn', type: 'submit' }, '保存')));
}

// ---------- users ----------

let userQuery = '';
let userPage = 1;

async function renderUsers(root, page) {
  root.append(stateBanner() || '');
  const search = el('input', { type: 'search', placeholder: '搜索用户名或昵称', value: userQuery, 'aria-label': '搜索用户' });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { userQuery = search.value.trim(); userPage = 1; load(); }, 250);
  });
  const box = el('div');
  root.append(head('用户', '所有注册的账号。封禁会让对方立刻下线且不能再登录；重置密码会生成一个临时密码。', search), box);

  async function load() {
    let data;
    try { data = await api('GET', 'users?q=' + encodeURIComponent(userQuery) + '&page=' + userPage); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.users.length) {
      box.replaceChildren(el('div', { class: 'table-wrap' }, el('p', { class: 'empty' }, userQuery ? '没有找到匹配的用户' : '还没有人注册。去概览页复制邀请文字发给朋友吧。')));
      return;
    }
    const typeTag = { bot: 'Bot', ai: 'AI' };
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['用户', '状态', '注册时间', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.users.map((u) => el('tr', {},
        el('td', {},
          el('b', {}, u.display_name),
          u.is_site_admin && el('span', { class: 'tag' }, '站点管理员'),
          typeTag[u.type] && el('span', { class: 'tag warn' }, typeTag[u.type]),
          el('span', { class: 'sub' }, '@' + u.username)),
        el('td', {},
          u.banned
            ? [el('span', { class: 'tag bad' }, '已封禁'), el('span', { class: 'sub' }, u.ban_reason)]
            : u.left_at ? [el('span', { class: 'tag warn' }, '已退出服务器'), el('span', { class: 'sub' }, fmtTime(u.left_at) + '，要新的邀请码才能回来')]
            : u.online ? el('span', { class: 'online' }, '在线') : el('span', { class: 'muted' }, fmtAgo(u.last_seen))),
        el('td', {}, fmtTime(u.created_at)),
        el('td', { class: 'actions' },
          el('button', { class: 'btn small ghost', onclick: () => showLogins(u) }, '登录记录'),
          el('button', { class: 'btn small ghost', onclick: () => clearProfile(u) }, '清空主页'),
          el('button', { class: 'btn small ghost', onclick: () => resetPassword(u) }, '重置密码'),
          el('button', { class: 'btn small ghost', onclick: () => toggleAdmin(u) }, u.is_site_admin ? '取消管理员' : '设为管理员'),
          u.banned
            ? el('button', { class: 'btn small', onclick: () => unban(u) }, '解封')
            : el('button', { class: 'btn small danger', onclick: () => ban(u) }, '封禁'))))))),
    pager(data.total, data.page_size, userPage, (p) => { userPage = p; load(); }));
  }

  async function ban(u) {
    const reason = await promptDialog({
      title: '封禁 ' + u.display_name, text: '对方会立刻下线，之后不能登录。原因会写进操作记录。',
      label: '原因', placeholder: '例如：用普通账号挂机器人', ok: '封禁',
    });
    if (reason == null) return;
    try { await api('POST', 'users/' + u.id + '/ban', { reason }); toast('已封禁 ' + u.display_name); load(); } catch (e) { fail(e); }
  }
  async function unban(u) {
    if (!await confirmDialog({ title: '解封 ' + u.display_name, text: '解封后对方可以重新登录。', ok: '解封' })) return;
    try { await api('POST', 'users/' + u.id + '/unban'); toast('已解封'); load(); } catch (e) { fail(e); }
  }
  async function toggleAdmin(u) {
    const on = !u.is_site_admin;
    const ok = await confirmDialog({
      title: (on ? '设为站点管理员：' : '取消站点管理员：') + u.display_name,
      text: on ? '站点管理员可以删除任何消息、查看违规证据、无限生成邀请码。' : '对方将不再有站点管理员权限。',
      ok: on ? '设为管理员' : '取消管理员',
    });
    if (!ok) return;
    try { await api('POST', 'users/' + u.id + '/admin', { admin: on }); toast('已更新'); load(); } catch (e) { fail(e); }
  }
  async function clearProfile(u) {
    const ok = await confirmDialog({
      title: '清空 ' + u.display_name + ' 的个人主页',
      text: '主页上的小组件全部移除（有违规内容时用）。原来的布局会作为旧版本保留一段时间，到期自动清除。会记入操作记录。',
      ok: '清空主页',
    });
    if (!ok) return;
    try { await api('POST', 'users/' + u.id + '/clear-profile'); toast('已清空 ' + u.display_name + ' 的主页'); } catch (e) { fail(e); }
  }

  async function resetPassword(u) {
    const ok = await confirmDialog({
      title: '重置 ' + u.display_name + ' 的密码',
      text: '会生成一个临时密码，对方所有设备都会退出登录。把临时密码私下告诉对方。',
      ok: '重置密码',
    });
    if (!ok) return;
    try {
      const r = await api('POST', 'users/' + u.id + '/reset-password');
      await infoDialog('新的临时密码', el('p', { class: 'muted' }, '只显示这一次。'), el('div', { class: 'big-secret' }, r.password),
        el('button', { class: 'btn', onclick: () => copy(r.password, '密码') }, '复制密码'));
    } catch (e) { fail(e); }
  }
  async function showLogins(u) {
    try {
      const r = await api('GET', 'users/' + u.id + '/logins');
      await infoDialog(u.display_name + ' 的登录记录',
        r.records.length
          ? el('div', { class: 'table-wrap' }, el('table', {},
            el('thead', {}, el('tr', {}, ['时间', 'IP', '设备'].map((h) => el('th', {}, h)))),
            el('tbody', {}, r.records.map((x) => el('tr', {},
              el('td', {}, fmtTime(x.at), x.kind === 'register' && el('span', { class: 'tag' }, '注册')),
              el('td', {}, el('code', {}, x.ip)), el('td', {}, x.device || '—'))))))
          : el('p', { class: 'muted' }, '没有记录'));
    } catch (e) { fail(e); }
  }
  load();
}

function pager(total, size, cur, go) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return el('div');
  return el('div', { class: 'pager' },
    el('span', { class: 'muted' }, '共 ' + total + ' 条，第 ' + cur + ' / ' + pages + ' 页'),
    el('button', { class: 'btn small', disabled: cur <= 1, onclick: () => go(cur - 1) }, '上一页'),
    el('button', { class: 'btn small', disabled: cur >= pages, onclick: () => go(cur + 1) }, '下一页'));
}

// ---------- invites ----------

let inviteFilter = 'unused';

async function renderInvites(root, page) {
  root.append(stateBanner() || '');
  const per = await api('GET', 'settings').then((r) => r.values['invites.per_user']).catch(() => null);
  root.append(head('邀请码', '每个账号注册后自动获得' + (per != null ? ' ' + per + ' 个' : '') +
    '邀请码，由用户自己在客户端里把加入码发给朋友。这里能看到每个码被谁用了，也可以作废没用过的码。'));

  const seg = el('div', { class: 'seg', role: 'tablist' });
  const box = el('div');
  root.append(el('div', { class: 'row list-head' }, el('span', { class: 'spacer' }), seg), box);

  let pageNo = 1;
  function drawSeg() {
    seg.replaceChildren(...[['unused', '未使用'], ['all', '全部']].map(([k, label]) => el('button', {
      class: inviteFilter === k ? 'on' : '', role: 'tab', 'aria-selected': String(inviteFilter === k),
      onclick: () => { inviteFilter = k; pageNo = 1; drawSeg(); load(); },
    }, label)));
  }
  drawSeg();

  async function load() {
    let data;
    try { data = await api('GET', 'invites?filter=' + inviteFilter + '&page=' + pageNo); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.invites.length) {
      box.replaceChildren(el('div', { class: 'table-wrap' }, el('p', { class: 'empty' }, inviteFilter === 'unused' ? '现在没有未使用的邀请码。' : '还没有邀请码。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['邀请码', '来源', '状态', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.invites.map((i) => el('tr', {},
        el('td', {}, el('code', { class: 'mono' }, groupCode(i.code)), i.makes_admin && el('span', { class: 'tag warn' }, '管理员'),
          i.note && el('span', { class: 'sub' }, i.note)),
        el('td', {}, i.created_by ? i.created_by_name : (i.makes_admin ? '首次启动（管理员）' : '管理面板'),
          el('span', { class: 'sub' }, fmtTime(i.created_at))),
        el('td', {}, i.used_by ? ['已被 ', el('b', {}, i.used_by_name), ' 使用', el('span', { class: 'sub' }, fmtTime(i.used_at))]
          : el('span', { class: 'muted' }, '未使用')),
        el('td', { class: 'actions' }, !i.used_by && [
          el('button', { class: 'btn small ghost', onclick: () => copy(i.code, '邀请码') }, '复制'),
          el('button', { class: 'btn small danger', onclick: () => del(i) }, '作废')])))))),
    el('div', { class: 'pager' },
      el('button', { class: 'btn small', disabled: pageNo <= 1, onclick: () => { pageNo--; load(); } }, '上一页'),
      el('button', { class: 'btn small', disabled: !data.more, onclick: () => { pageNo++; load(); } }, '下一页')));
  }
  async function del(i) {
    if (!await confirmDialog({ title: '作废邀请码 ' + i.code + '？', text: '作废后这个码不能再注册。', ok: '作废' })) return;
    try { await api('DELETE', 'invites/' + encodeURIComponent(i.code)); toast('已作废'); load(); } catch (e) { fail(e); }
  }
  load();
}

// ---------- channel history ----------

let channelQuery = '';
let channelPage = 1;

// #/channels lists every channel (public and private); #/channels/<id>
// shows one channel's messages, read-only. Direct messages are never shown.
async function renderChannels(root, page) {
  root.append(stateBanner() || '');
  const id = (location.hash.match(/^#\/channels\/(\d+)/) || [])[1];
  if (id) return renderChannel(root, page, id);
  const search = el('input', { type: 'search', placeholder: '搜索频道名', value: channelQuery, 'aria-label': '搜索频道' });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { channelQuery = search.value.trim(); channelPage = 1; load(); }, 250);
  });
  const box = el('div');
  root.append(head('频道记录', '所有频道（公开和私密）的聊天记录，只能看不能改。私信看不到。打开某个频道会记入操作记录。「允许 NSFW」只能在这里按频道设置：打开后 AI 在这个频道能画成人内容，博物馆和电子厕所也能放 NSFW 图（涉及未成年的永远不画）。', search), box);
  async function load() {
    let data;
    try { data = await api('GET', 'channels?q=' + encodeURIComponent(channelQuery) + '&page=' + channelPage); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'table-wrap' }, el('p', { class: 'empty' }, channelQuery ? '没有找到匹配的频道' : '还没有频道。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['频道', '人数', '记录数', '创建时间', '允许 NSFW', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.items.map((c) => el('tr', {},
        el('td', {},
          el('b', {}, c.name),
          el('span', { class: 'tag' + (c.public ? '' : ' warn') }, c.public ? '公开' : '私密'),
          c.dissolved && el('span', { class: 'tag bad' }, '已解散'),
          c.owner_name && el('span', { class: 'sub' }, '频道主：' + c.owner_name)),
        el('td', {}, c.members),
        el('td', {}, c.messages),
        el('td', {}, fmtTime(c.created_at)),
        el('td', {}, c.dissolved ? '' : nsfwSwitch(c)),
        el('td', { class: 'actions' }, el('a', { class: 'btn small ghost', href: '#/channels/' + c.id }, '查看记录'))))))),
    pager(data.total, data.page_size, channelPage, (p) => { channelPage = p; load(); }));
  }
  load();
}

// The per-channel NSFW switch (saved at once; members see a system line).
function nsfwSwitch(c) {
  const box = el('input', { type: 'checkbox', checked: c.nsfw, 'aria-label': '允许 NSFW：' + c.name });
  box.addEventListener('change', async () => {
    box.disabled = true;
    try {
      await api('POST', 'channels/' + c.id + '/nsfw', { on: box.checked });
      c.nsfw = box.checked;
      toast((box.checked ? '已允许' : '已关闭') + '「' + c.name + '」的 NSFW');
    } catch (e) { box.checked = c.nsfw; fail(e); }
    box.disabled = false;
  });
  return el('label', { class: 'check' }, box, el('span', {}, '允许'));
}

async function renderChannel(root, page, id) {
  const title = el('h1', {}, '频道记录');
  const tags = el('span');
  root.append(el('div', { class: 'page-head' },
    el('div', {}, el('a', { class: 'back', href: '#/channels' }, '← 所有频道'), el('div', { class: 'row' }, title, tags),
      el('p', {}, '只读。打开这个频道已记入操作记录。')),
  ));
  const list = el('div', { class: 'history' });
  const more = el('button', { class: 'btn small ghost', onclick: () => load(before) }, '加载更早的消息');
  const top = el('div', { class: 'history-top' });
  root.append(el('div', { class: 'panel' }, top, list));
  let before = 0;
  async function load(from) {
    more.disabled = true;
    let data;
    try { data = await api('GET', 'channels/' + id + '/events' + (from ? '?before=' + from : '')); } catch (e) { fail(e); more.disabled = false; return; }
    if (currentPage !== page) return;
    if (!from) {
      title.textContent = data.channel.name;
      tags.replaceChildren(el('span', { class: 'tag' + (data.channel.public ? '' : ' warn') }, data.channel.public ? '公开' : '私密'),
        data.channel.dissolved ? el('span', { class: 'tag bad' }, '已解散') : '');
    }
    before = data.before;
    const rows = data.items.map(historyItem);
    if (!from && !rows.length) rows.push(el('p', { class: 'empty' }, '这个频道还没有消息。'));
    const keep = list.scrollHeight - list.scrollTop;
    list.prepend(...rows);
    if (from) list.scrollTop = list.scrollHeight - keep; else list.scrollTop = list.scrollHeight;
    more.disabled = false;
    top.replaceChildren(before ? more : el('span', { class: 'muted' }, '已经到最早的消息了'));
  }
  load(0);
}

function historyItem(x) {
  if (x.kind === 'sys') return el('div', { class: 'h-sys' }, x.text, ' · ', fmtTime(x.at));
  let content;
  if (x.kind === 'text') content = x.text;
  else if (x.kind === 'image') content = el('a', { href: 'api/media/' + x.media_id, target: '_blank', rel: 'noopener' },
    el('img', { src: 'api/media/' + x.media_id + '?thumb=1', alt: '图片', loading: 'lazy' }));
  else if (x.kind === 'file') content = ['[文件] ', el('a', { href: 'api/media/' + x.media_id }, x.file_name), ' ', fmtBytes(x.file_size || 0)];
  else if (x.kind === 'deleted') content = el('span', { class: 'muted' }, '已被 ' + x.deleted_by + ' 删除，原因：' + x.reason + '（原内容在「删除记录」里）');
  const avatar = x.sender_avatar
    ? el('img', { class: 'h-avatar', src: 'api/media/' + x.sender_avatar + '?thumb=1', alt: '' })
    : el('span', { class: 'h-avatar' }, (x.sender_name || '?').slice(0, 1));
  return el('div', { class: 'h-msg' }, avatar,
    el('div', {},
      el('div', { class: 'h-meta' }, el('b', {}, x.sender_name), ' ', el('span', { class: 'muted' }, fmtTime(x.at)),
        x.struck && el('span', { class: 'tag warn' }, '已划掉')),
      el('div', { class: 'h-body' + (x.struck ? ' struck' : '') }, content)));
}

// ---------- evidence ----------

async function renderEvidence(root, page) {
  root.append(stateBanner() || '');
  const days = await api('GET', 'settings').then((r) => r.values['retention.evidence_days']).catch(() => null);
  root.append(head('删除记录', '群管理员或站点管理员删除的消息，对所有用户都看不到了，但原内容会在这里保留' +
    (days ? ' ' + days + ' 天' : '一段时间') + '作为证据，到期自动清除。只有你能看到这里。'));
  const box = el('div');
  root.append(box);
  let pageNo = 1;
  async function load() {
    let data;
    try { data = await api('GET', 'evidence?page=' + pageNo); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty' }, '还没有被删除的消息。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'stack' }, data.items.map((x) => {
      let content;
      if (x.kind === 'text') content = x.text;
      else if (x.kind === 'image') content = x.media_id ? el('a', { href: 'api/media/' + x.media_id, target: '_blank', rel: 'noopener' },
        el('img', { src: 'api/media/' + x.media_id + '?thumb=1', alt: '被删除的图片' })) : '[图片]';
      else if (x.kind === 'file') content = ['[文件] ', x.media_id ? el('a', { href: 'api/media/' + x.media_id }, x.file_name) : x.file_name, ' ', fmtBytes(x.file_size || 0)];
      else content = '[其他内容]';
      const where = x.conv_kind === 'group' ? '群「' + x.conv_name + '」' : '私聊';
      return el('article', { class: 'panel evidence' },
        el('div', {}, el('b', {}, x.sender_name || '未知用户'), el('span', { class: 'muted' }, ' 在' + where + '发的消息')),
        el('div', { class: 'meta' }, fmtTime(x.deleted_at)),
        el('div', { class: 'content' }, content),
        el('div', { class: 'meta' }, x.deleted_by_name + ' 删除，原因：' + x.reason),
        el('div', { class: 'meta' }, '保留到 ' + fmtDate(x.purge_after)));
    })), pager(data.total, data.page_size, pageNo, (p) => { pageNo = p; load(); }));
  }
  load();
}

// ---------- sticker library ----------

let stickerQuery = '';
let stickerStatus = 'visible';
let stickerSort = 'hot';
let stickerPageNo = 1;

// The shared sticker library (docs/design.md §11): what everyone on the
// server sees under 「大家的」. Hide = not listed any more (people who
// have it keep it); delete = gone from every collection, the picture is
// kept here as evidence until it is purged.
async function renderStickers(root, page) {
  root.append(stateBanner() || '');
  const search = el('input', { type: 'search', placeholder: '按标签搜', value: stickerQuery, 'aria-label': '按标签搜表情' });
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { stickerQuery = search.value.trim(); stickerPageNo = 1; load(); }, 250);
  });
  const status = el('select', { 'aria-label': '显示哪些', onchange: () => { stickerStatus = status.value; stickerPageNo = 1; load(); } },
    [['visible', '公开的'], ['hidden', '已隐藏'], ['deleted', '已删除'], ['all', '全部']].map(([v, n]) => el('option', { value: v, selected: v === stickerStatus }, n)));
  const sort = el('select', { 'aria-label': '排序', onchange: () => { stickerSort = sort.value; stickerPageNo = 1; load(); } },
    [['hot', '收藏多的在前'], ['new', '新加的在前']].map(([v, n]) => el('option', { value: v, selected: v === stickerSort }, n)));
  const box = el('div');
  root.append(head('表情库', '大家加进收藏的表情都在这里（同一张图只有一份，显示最早上传的人）。隐藏：「大家的」里不再出现，已经收藏的人还能用。删除：所有人的收藏里都没了，原图在这里保留到期后自动清除。',
    el('div', { class: 'sticker-filters' }, search, status, sort)), box);

  async function load() {
    let data;
    try {
      data = await api('GET', 'stickers?q=' + encodeURIComponent(stickerQuery) + '&status=' + stickerStatus + '&sort=' + stickerSort + '&page=' + stickerPageNo);
    } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty' }, stickerQuery ? '没有这个标签的表情' : '这里还没有表情。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'sticker-grid' }, data.items.map(card)),
      pager(data.total, data.page_size, stickerPageNo, (p) => { stickerPageNo = p; load(); }));
  }

  function card(x) {
    const img = el('a', { href: 'api/media/' + x.media_id, target: '_blank', rel: 'noopener', class: 'pic' },
      el('img', { src: 'api/media/' + x.media_id + '?thumb=1', alt: x.tags.join('、') || '表情', loading: 'lazy' }));
    const tags = el('div', { class: 'tags' }, x.tags.length ? x.tags.map((tag) => el('span', { class: 'tag' }, tag,
      x.deleted_at ? '' : el('button', { class: 'x', type: 'button', title: '删掉这个标签', 'aria-label': '删掉标签 ' + tag, onclick: () => removeTag(x, tag) }, '×')))
      : el('span', { class: 'muted' }, '没有标签'));
    const state = x.deleted_at ? el('span', { class: 'tag bad' }, '已删除') : x.hidden_at ? el('span', { class: 'tag warn' }, '已隐藏') : '';
    const actions = x.deleted_at ? el('div', { class: 'meta' }, '原因：' + x.delete_reason, el('br'), '保留到 ' + fmtDate(x.purge_after))
      : el('div', { class: 'row' },
        el('button', { class: 'btn small ghost', type: 'button', onclick: () => setHidden(x, !x.hidden_at) }, x.hidden_at ? '恢复显示' : '隐藏'),
        el('button', { class: 'btn small danger', type: 'button', onclick: () => del(x) }, '删除'));
    return el('article', { class: 'panel sticker-card' }, img,
      el('div', { class: 'meta' }, state, state ? ' ' : '', (x.uploader_name || '(已不存在的账号)') + ' 最早上传 · ' + x.collectors + ' 人收藏'),
      el('div', { class: 'meta' }, fmtTime(x.created_at)),
      tags, actions);
  }

  async function setHidden(x, hidden) {
    try {
      await api('POST', 'stickers/' + x.id + '/hide', { hidden });
      toast(hidden ? '已隐藏' : '已恢复显示');
      load();
    } catch (e) { fail(e); }
  }

  async function removeTag(x, tag) {
    if (!await confirmDialog({ title: '删掉标签', text: '把「' + tag + '」从这张表情上删掉（所有人加的这个标签都会去掉）。', ok: '删掉', danger: true })) return;
    try {
      await api('POST', 'stickers/' + x.id + '/remove-tag', { tag });
      toast('标签已删掉');
      load();
    } catch (e) { fail(e); }
  }

  async function del(x) {
    const res = await dialog((close) => {
      const reason = el('input', { type: 'text', maxlength: 200, placeholder: '比如：违规内容' });
      const block = el('input', { type: 'checkbox' });
      const submit = (e) => {
        e.preventDefault();
        if (!reason.value.trim()) { reason.focus(); return; }
        close({ reason: reason.value.trim(), block: block.checked });
      };
      return [el('form', { onsubmit: submit },
        el('h2', {}, '删除这张表情'),
        el('div', { class: 'body' },
          el('p', { class: 'muted' }, '所有人的收藏里都会去掉它，「大家的」里也看不到了。已经发出去的消息不受影响（要删消息请在频道记录里处理）。原图会在「表情库 → 已删除」里保留到期后自动清除。'),
          el('label', {}, el('div', { class: 'field-label' }, '原因（会记入操作记录）'), reason),
          el('label', { class: 'check' }, block, el('span', {}, '同时拉黑这张图（以后再上传会被拒绝，改过尺寸的也算）'))),
        el('div', { class: 'foot' },
          el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '取消'),
          el('button', { class: 'btn primary danger-fill', type: 'submit' }, '删除')))];
    });
    if (!res) return;
    try {
      await api('POST', 'stickers/' + x.id + '/delete', res);
      toast('已删除');
      load();
    } catch (e) { fail(e); }
  }

  load();
}

// ---------- Plugins (on the built-in bot) ----------

// Plugins (docs/plugins.md): NoneBot plugins run as the server's built-in
// bot, and only site admins upload them, here. They are programs with full
// access to this computer, so read the code before uploading.
async function renderPlugins(root, page) {
  root.append(stateBanner() || '');
  const file = el('input', { type: 'file', accept: '.zip,application/zip', hidden: true, onchange: () => { if (file.files[0]) upload(file.files[0]); file.value = ''; } });
  const upBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => file.click() }, '上传插件');
  const box = el('div');
  root.append(head('插件', '给小助手装 NoneBot2 插件：上传一个 zip（里面是插件文件夹，一个或几个都行），马上以小助手的身份运行，大家在频道和私信里用它的命令。同名文件夹再传一次 = 更新（设置保留）。插件是程序，能读写这台电脑上的文件、联网，上传前先看过代码。',
    upBtn, file), box);

  const HOST = { running: '运行中', starting: '启动中', preparing: '安装依赖中', error: '出错了', off: '没在运行' };
  let botName = '小助手';

  async function load() {
    let data;
    try {
      data = await api('GET', 'plugins');
    } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.enabled) {
      upBtn.disabled = true;
      box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty' }, '插件功能已关闭（设置 → config.toml 里的 [plugins] enabled）。')));
      return;
    }
    botName = data.bot_name || botName;
    const state = el('div', { class: 'panel' },
      el('div', { class: 'row' }, el('strong', {}, botName + ' 的插件进程'),
        el('span', { class: 'tag ' + (data.host_state === 'running' ? 'good' : data.host_state === 'error' ? 'bad' : '') }, HOST[data.host_state] || data.host_state || '没在运行')),
      data.host_error ? el('div', { class: 'meta bad' }, data.host_error) : '',
      data.log && data.log.length ? el('details', {}, el('summary', {}, '最近的输出'), el('pre', { class: 'code' }, data.log.join('\n'))) : '');
    if (!data.items.length) {
      box.replaceChildren(state, el('div', { class: 'panel' }, el('p', { class: 'empty' }, '还没有插件。')));
      return;
    }
    box.replaceChildren(state, ...data.items.map(card));
  }

  async function upload(f) {
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    upBtn.disabled = true;
    try {
      const r = await api('POST', 'plugins/upload', { data });
      toast('已装好：' + r.items.map((x) => x.name || x.dir).join('、'));
      load();
    } catch (e) { fail(e); } finally { upBtn.disabled = false; }
  }

  function card(x) {
    const lines = [
      el('div', { class: 'row' }, el('strong', {}, x.name || x.dir), el('span', { class: 'muted' }, x.dir),
        el('span', { class: 'tag ' + (x.enabled ? 'good' : '') }, x.enabled ? '启用' : '已停用')),
      el('div', { class: 'meta' }, '上传于 ' + fmtTime(x.uploaded_at)),
    ];
    if (x.description) lines.push(el('p', {}, x.description));
    if (x.commands && x.commands.length) lines.push(el('div', { class: 'meta' }, '命令：' + x.commands.map((c) => '/' + c).join('、')));
    if (x.usage) lines.push(el('div', { class: 'meta' }, '用法：' + x.usage));
    lines.push(el('div', { class: 'meta' }, '需要安装：' + (x.requires && x.requires.length ? x.requires.join('、') : '无（只用 NoneBot 自带的）') + ' · ' + x.config_items.length + ' 项设置'));
    lines.push(el('div', { class: 'row' },
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => files(x) }, '看代码'),
      x.config_items.length ? el('button', { class: 'btn small', type: 'button', onclick: () => settings(x) }, '设置') : '',
      el('button', { class: 'btn small', type: 'button', onclick: (e) => toggle(x, e.currentTarget) }, x.enabled ? '停用' : '启用'),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => remove(x) }, '删除')));
    return el('article', { class: 'panel' }, lines);
  }

  async function toggle(x, btn) {
    btn.disabled = true;
    try {
      await api('PUT', 'plugins/' + x.id, { enabled: !x.enabled });
      toast(x.enabled ? '已停用' : '已启用');
      load();
    } catch (e) { fail(e); btn.disabled = false; }
  }

  async function remove(x) {
    if (!await confirmDialog({ title: '删除「' + (x.name || x.dir) + '」', text: '插件文件会删掉（它自己存的数据留着）。', ok: '删除', danger: true })) return;
    try {
      await api('DELETE', 'plugins/' + x.id);
      toast('已删除');
      load();
    } catch (e) { fail(e); }
  }

  // settings: one field per setting the plugin reads. Empty = its default;
  // secrets are never shown (empty = keep what is set).
  async function settings(x) {
    const fields = x.config_items.map((c) => {
      const has = Object.prototype.hasOwnProperty.call(x.values || {}, c.key);
      const v = has ? x.values[c.key] : undefined;
      const def = c.default === undefined || c.default === null ? '' : typeof c.default === 'string' ? c.default : JSON.stringify(c.default);
      let input;
      if (c.secret) {
        const set = (x.secrets_set || []).includes(c.key);
        input = el('input', { type: 'password', autocomplete: 'off', placeholder: set ? '已设置（留空不改）' : '没设置' });
      } else if (c.type === 'bool') {
        input = el('input', { type: 'checkbox', checked: has ? v === true : c.default === true });
      } else if (c.type === 'select' && c.options && c.options.length) {
        input = el('select', {}, el('option', { value: '' }, '默认' + (def ? '（' + def + '）' : '')),
          c.options.map((o) => el('option', { value: o, selected: has && v === o }, o)));
      } else if (c.type === 'text') {
        input = el('textarea', { rows: 4, placeholder: def }, has ? String(v) : '');
      } else {
        const num = c.type === 'int' || c.type === 'float';
        input = el('input', { type: num ? 'number' : 'text', step: c.type === 'int' ? 1 : num ? 'any' : null, min: c.min, max: c.max, placeholder: def,
          value: has ? (typeof v === 'string' ? v : JSON.stringify(v)) : '' });
      }
      return { c, input, has, v };
    });
    const res = await dialog((close) => {
      const submit = (e) => {
        e.preventDefault();
        const patch = {};
        for (const { c, input, has, v } of fields) {
          if (c.secret) { if (input.value !== '') patch[c.key] = input.value; continue; }
          if (c.type === 'bool') {
            if (input.checked !== (has ? v === true : c.default === true)) patch[c.key] = input.checked;
            continue;
          }
          const t = input.value.trim();
          if (t === '') { if (has) patch[c.key] = null; continue; }
          let val = t;
          if (c.type === 'int' || c.type === 'float') val = Number(t);
          else if (c.type === 'list') {
            try { val = JSON.parse(t); } catch { val = t.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean); }
          }
          if (!has || JSON.stringify(val) !== JSON.stringify(v)) patch[c.key] = val;
        }
        close({ patch });
      };
      const rows = fields.map(({ c, input }, i) => {
        input.id = 'plugin-set-' + i;
        const ctl = c.type === 'bool' && !c.secret ? el('label', { class: 'check' }, input, el('span', {}, '开启')) : input;
        const help = [c.help, c.type === 'list' ? '列表：用逗号隔开，或写 JSON' : ''].filter(Boolean).join(' · ');
        return el('div', { class: 'setting' },
          el('div', { class: 'lbl' }, el('label', { for: input.id }, el('b', {}, c.label || c.key)), el('span', {}, (c.label ? c.key + (help ? ' · ' : '') : '') + help)),
          el('div', { class: 'ctl' }, ctl));
      });
      return [el('form', { onsubmit: submit },
        el('h2', {}, (x.name || x.dir) + ' 的设置'),
        el('div', { class: 'body settings' }, rows),
        el('div', { class: 'foot' },
          el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '取消'),
          el('button', { class: 'btn primary', type: 'submit' }, '保存')))];
    }, 'wide');
    if (!res) return;
    if (!Object.keys(res.patch).length) { toast('没有改动'); return; }
    try {
      await api('PUT', 'plugins/' + x.id, { config_patch: JSON.stringify(res.patch) });
      toast('设置已保存，插件会重新启动');
      load();
    } catch (e) { fail(e); }
  }

  async function files(x) {
    let list;
    try {
      list = (await api('GET', 'plugins/' + x.id + '/files')).files || [];
    } catch (e) { fail(e); return; }
    await dialog((close) => {
      const code = el('pre', { class: 'code' }, '点左边的文件查看');
      const show = async (f, btn) => {
        try {
          const r = await api('GET', 'plugins/' + x.id + '/files?path=' + encodeURIComponent(f.path));
          code.textContent = r.binary ? '（二进制文件，' + f.size + ' 字节）' : r.text + (r.cut ? '\n…（太长，只显示前 512 KB）' : '');
          list.forEach((_, i) => names.children[i] && names.children[i].classList.remove('on'));
          btn.classList.add('on');
        } catch (e) { fail(e); }
      };
      const names = el('div', { class: 'file-list' }, list.map((f) => {
        const b = el('button', { type: 'button', class: 'file' }, f.path, el('span', { class: 'muted' }, ' ' + fmtBytes(f.size)));
        b.addEventListener('click', () => show(f, b));
        return b;
      }));
      const first = list.find((f) => f.path === '__init__.py') || list[0];
      if (first) setTimeout(() => show(first, names.children[list.indexOf(first)]), 0);
      return [el('h2', {}, (x.name || x.dir) + ' 的文件'),
        el('div', { class: 'body plugin-files' }, names, code),
        el('div', { class: 'foot' }, el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '关闭'))];
    }, 'wide');
  }

  load();
}

// ---------- AI hosting ----------

let hostingStatus = 'pending';

// AIs run on this server (docs/design.md §10 托管): approving starts the AM
// client without a window for that AI on this computer, with the owner's
// model keys and its own work folder; rejecting an approved one stops it.
async function renderHosting(root, page) {
  root.append(stateBanner() || '');
  const status = el('select', { 'aria-label': '显示哪些', onchange: () => { hostingStatus = status.value; load(); } },
    [['pending', '待审核'], ['approved', '托管中'], ['rejected', '已拒绝'], ['', '全部']].map(([v, n]) => el('option', { value: v, selected: v === hostingStatus }, n)));
  const box = el('div');
  root.append(head('AI 托管', '大家申请把自己的 AI 放到这台电脑上运行（主人的电脑关着它也在线）。批准后 am-server 会在后台启动 AM 客户端（不显示窗口）替他运行，用的是主人自己的模型 key。托管的 AI 只能在它自己的文件夹里读写文件，不能看屏幕、动鼠标键盘、运行命令、开浏览器。这台电脑上要装好 AM 客户端。',
    el('div', { class: 'sticker-filters' }, status)), box);

  const STATUS = { pending: ['待审核', 'warn'], approved: ['托管中', 'good'], rejected: ['已拒绝', 'bad'] };
  const STATE = { running: '在线', starting: '启动中', error: '出错了', off: '没在运行' };

  async function load() {
    let data;
    try {
      data = await api('GET', 'hosting?status=' + hostingStatus);
    } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.enabled) {
      box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty' }, 'AI 托管已关闭（config.toml 的 [hosting]：enabled、max_per_user）。')));
      if (!data.items.length) return;
    } else if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'panel' }, el('p', { class: 'empty' }, hostingStatus === 'pending' ? '没有等待审核的申请。' : '这里还没有。')));
      return;
    }
    box.replaceChildren(...data.items.map(card));
  }

  function card(x) {
    const [stText, stClass] = STATUS[x.status] || [x.status, ''];
    const lines = [
      el('div', { class: 'row' }, el('strong', {}, x.ai_name || '(已删除的 AI)'), el('span', { class: 'tag ' + stClass }, stText),
        x.status === 'approved' ? el('span', { class: 'muted' }, STATE[x.state] || x.state) : ''),
      el('div', { class: 'meta' }, '主人：' + (x.owner_name || '?') + ' · 申请于 ' + fmtTime(x.requested_at)),
    ];
    if (x.status === 'approved') lines.push(el('div', { class: 'meta' }, '工作文件夹：' + x.work_dir));
    if (x.reject_reason) lines.push(el('div', { class: 'meta' }, '原因：' + x.reject_reason));
    if (x.error) lines.push(el('div', { class: 'meta bad' }, x.error));
    if (x.log && x.log.length) {
      const pre = el('pre', { class: 'code', hidden: true }, x.log.join('\n'));
      lines.push(el('button', { class: 'btn small ghost', type: 'button', onclick: () => { pre.hidden = !pre.hidden; } }, '客户端日志'), pre);
    }
    lines.push(el('div', { class: 'row' },
      x.status !== 'approved' ? el('button', { class: 'btn small primary', type: 'button', onclick: () => decide(x, true) }, '批准') : '',
      x.status !== 'rejected' ? el('button', { class: 'btn small danger', type: 'button', onclick: () => decide(x, false) }, x.status === 'approved' ? '停止托管' : '拒绝') : ''));
    return el('article', { class: 'panel' }, lines);
  }

  async function decide(x, approve) {
    let reason = '';
    if (approve) {
      if (!await confirmDialog({ title: '托管「' + (x.ai_name || 'AI') + '」', text: '批准后会在这台电脑上一直运行它（占一些内存和网络），用 ' + (x.owner_name || '主人') + ' 自己的模型 key。', ok: '批准' })) return;
    } else {
      const res = await dialog((close) => {
        const input = el('input', { type: 'text', maxlength: 200, placeholder: '比如：电脑跑不动了' });
        const submit = (e) => { e.preventDefault(); close({ reason: input.value.trim() }); };
        return [el('form', { onsubmit: submit },
          el('h2', {}, (x.status === 'approved' ? '停止托管「' : '拒绝「') + (x.ai_name || 'AI') + '」'),
          el('div', { class: 'body' }, el('label', {}, el('div', { class: 'field-label' }, '原因（主人能看到，也记入操作记录）'), input)),
          el('div', { class: 'foot' },
            el('button', { class: 'btn', type: 'button', onclick: () => close(null) }, '取消'),
            el('button', { class: 'btn primary danger-fill', type: 'submit' }, x.status === 'approved' ? '停止' : '拒绝')))];
      });
      if (!res) return;
      reason = res.reason;
    }
    try {
      await api('POST', 'hosting/' + x.ai_id + '/decide', { approve, reason });
      toast(approve ? '已批准，正在启动' : (x.status === 'approved' ? '已停止' : '已拒绝'));
      refreshStatus();
      load();
    } catch (e) { fail(e); }
  }

  load();
}

// ---------- audit ----------

const AUDIT_TEXT = {
  admin_delete: '删除了一条消息', kick: '把人移出了群', mute: '禁言了', transfer: '转让了群',
  dissolve: '解散了群', ban: '封禁了', unban: '解封了', site_admin_grant: '设为站点管理员：',
  site_admin_remove: '取消了站点管理员：', password_reset: '重置了密码：', invite_create: '生成了邀请码',
  invite_delete: '作废了邀请码', channel_view: '在管理面板查看了聊天记录', server_profile: '修改了服务器主页设置',
  server_layout: '修改了服务器主页的小组件', profile_clear: '清空了个人主页：', guestbook_delete: '删除了一条留言',
  sticker_hide: '在表情库里隐藏了一张表情', sticker_unhide: '在表情库里恢复显示了一张表情',
  plugin_upload: '上传了插件：', plugin_approve: '批准了 AI 插件：', plugin_reject: '拒绝 / 停用了 AI 插件：',
  hosting_approve: '批准了 AI 托管', hosting_reject: '拒绝 / 停止了 AI 托管',
  sticker_delete: '从表情库删除了一张表情', sticker_tag_remove: '删掉了表情库里的一个标签：',
};

async function renderAudit(root, page) {
  root.append(stateBanner() || '');
  root.append(head('操作记录', '管理操作都会记在这里，不能删除。'));
  const box = el('div');
  root.append(box);
  let pageNo = 1;
  async function load() {
    let data;
    try { data = await api('GET', 'audit?page=' + pageNo); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'table-wrap' }, el('p', { class: 'empty' }, '还没有管理操作。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['时间', '谁', '做了什么', '详情'].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.items.map((x) => el('tr', {},
        el('td', {}, fmtTime(x.at)),
        el('td', {}, x.actor_id ? x.actor_name || '(已不存在)' : el('span', { class: 'tag' }, '管理面板')),
        el('td', {}, (AUDIT_TEXT[x.action] || x.action) + ' ', x.target_name && el('b', {}, x.target_name),
          x.conv_name && el('span', { class: 'sub' }, '频道「' + x.conv_name + '」')),
        el('td', { class: 'muted' }, auditDetail(x))))))),
    pager(data.total, data.page_size, pageNo, (p) => { pageNo = p; load(); }));
  }
  load();
}

function auditDetail(x) {
  if (x.action === 'mute') {
    const m = /until=(\d+)/.exec(x.detail);
    if (m) return Number(m[1]) === 0 ? '解除禁言' : '到 ' + fmtTime(Number(m[1]));
  }
  if (x.action === 'invite_create') return x.detail.replace('note=', '备注：').replace('makes_admin', '（管理员码）');
  if (x.action === 'invite_delete') return x.detail.replace('code=', '');
  return x.detail;
}

// ---------- logs ----------

async function renderLogs(root, page) {
  let paused = false;
  const pauseBtn = el('button', { class: 'btn', onclick: () => { paused = !paused; pauseBtn.textContent = paused ? '继续滚动' : '暂停滚动'; } }, '暂停滚动');
  const pane = el('div', { class: 'logs', role: 'log', 'aria-live': 'off', tabindex: '0' });
  root.append(head('运行日志', '服务器最近的输出，也保存在数据文件夹的 logs 里。出问题时把这里的内容发给开发者。',
    el('button', { class: 'btn', onclick: () => copy(pane.textContent, '日志') }, '复制全部'), pauseBtn), pane);
  let after = 0;
  async function poll() {
    if (currentPage !== page) return;
    try {
      const r = await api('GET', 'logs?after=' + after);
      if (r.lines.length) {
        const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
        for (const l of r.lines) {
          const lvl = (/level=(\w+)/.exec(l.text) || [])[1] || '';
          pane.append(el('div', { class: lvl }, l.text));
          after = l.seq;
        }
        while (pane.childElementCount > 2000) pane.firstChild.remove();
        if (!paused && (nearBottom || after === r.lines[r.lines.length - 1].seq && pane.childElementCount === r.lines.length)) {
          pane.scrollTop = pane.scrollHeight;
        }
      }
    } catch { /* keep polling */ }
    page.timer = setTimeout(poll, 2000);
  }
  page.leave = () => clearTimeout(page.timer);
  poll();
}

// ---------- settings ----------

const SETTINGS = [
  { title: '基本', items: [
    { k: 'server.name', label: '服务器名称', help: '显示在客户端里', type: 'text', max: 32 },
    { k: 'server.public_address', label: '公网地址', help: '外面的朋友连接用的 IP 或域名加端口。用 frp 时填中转服务器的 IP 和远程端口。', type: 'text', placeholder: '47.1.2.3:7000' },
    { k: 'server.listen', label: '监听地址', help: '本机监听的地址和端口，一般不用改', type: 'text' },
    { k: 'server.proxy_protocol', label: '读取真实 IP（proxy protocol）', help: '只有所有外部连接都经过 frp 且 frp 开了 proxy protocol 时才打开，否则别人连不上。', type: 'bool' },
  ] },
  { title: '邀请', items: [
    { k: 'invites.per_user', label: '每个账号的邀请码数量', help: '注册后自动发放，用户在客户端里发给朋友', type: 'int', min: 0, max: 100 },
    { k: 'invites.admin_unlimited', label: '站点管理员可以额外要邀请码', type: 'bool' },
    { k: 'invites.download_url', label: '客户端下载页', help: '二维码指向这里。别的软件扫码会打开这个页面，AM 客户端扫码直接读出加入码。', type: 'text' },
  ] },
  { title: '限制', items: [
    { k: 'limits.max_text_length', label: '单条消息最多字数', type: 'int', min: 1 },
    { k: 'limits.max_group_members', label: '群人数上限', type: 'int', min: 2 },
    { k: 'limits.max_upload_mb', label: '单个文件最大（MB）', type: 'int', min: 1 },
    { k: 'limits.login_attempts_per_minute', label: '每个 IP 每分钟登录次数', help: '防止有人猜密码，0 表示不限', type: 'int', min: 0 },
    { k: 'limits.max_devices', label: '每个账号最多登录几台设备', help: '电脑、手机都算，bot / AI 账号不算。满了以后要先在一台设备上退出才能登录新设备。0 表示不限', type: 'int', min: 0, max: 50 },
    { k: 'limits.pair_code_minutes', label: '添加新设备的登录码有效几分钟', type: 'int', min: 1, max: 60 },
    { k: 'limits.max_ai_per_user', label: '每人最多建几个 AI', help: 'AI 在主人自己的电脑上运行，用主人的 key', type: 'int', min: 0, max: 50 },
  ] },
  { title: '留存', items: [
    { k: 'retention.evidence_days', label: '删除记录保留天数', help: '被删除消息的原内容保留多久，法规要求至少 180 天', type: 'int', min: 1, warnBelow: 180 },
    { k: 'retention.login_record_days', label: '登录记录保留天数', help: '登录时间、IP、设备，法规要求至少 180 天', type: 'int', min: 1, warnBelow: 180 },
  ] },
  { title: '表情包', items: [
    { k: 'stickers.library', label: '公共表情库', help: '大家加进收藏的表情会出现在别人的「大家的」里，可以搜索和收藏，标签大家一起补。关掉后只剩各人自己的收藏。', type: 'bool' },
    { k: 'stickers.default_public', label: '新加的表情默认公开', help: '关掉后默认不公开，大家要自己选「公开」才进公共库', type: 'bool' },
    { k: 'stickers.dedupe_distance', label: '算作同一张图的相似度', help: '0–64，0 表示只有完全相同的文件才合并。10 能合并重新保存、改过尺寸的同一张图；调大可能把字不一样的表情合到一起。', type: 'int', min: 0, max: 64 },
    { k: 'limits.max_stickers', label: '每人最多收藏几个表情', type: 'int', min: 0 },
  ] },
  { title: '图片黑名单', items: [
    { k: 'media.block_distance', label: '相似度容差', help: '0–64，越小越严格。6 能拦住改过尺寸或重新压缩的同一张图。', type: 'int', min: 0, max: 64 },
  ] },
  { title: '画画（小助手，NovelAI）', items: [
    { k: 'draw.enabled', label: '画画', help: '大家（和 AI）发 /nai、/nai5 等指令让小助手画；AI 想画时也是叫小助手画，还能用自己的头像当角色参考', type: 'bool' },
    { k: 'draw.token', label: 'NovelAI token', help: 'NovelAI 网页 → 设置 → Account → Get Persistent API Token。整个服务器共用这一个，花的是这个账号的 Anlas', type: 'secret' },
    { k: 'draw.proxy', label: '代理', help: '访问 NovelAI 用，比如 http://127.0.0.1:7890。不填 = 直连', type: 'text' },
    { k: 'draw.daily_per_person', label: '每人每天最多画几张', help: '站点管理员不限；0 = 谁都不限', type: 'int', min: 0 },
    { k: 'draw.max_count', label: '一条指令最多出几张', type: 'int', min: 1, max: 16 },
    { k: 'draw.nsfw_in_dm', label: '私聊小助手时允许 NSFW', help: '频道里按「频道记录」里每个频道的开关', type: 'bool' },
  ] },
  { title: '内置 bot 和游戏资讯', items: [
    { k: 'helper.name', label: 'bot 第一次建号时的名字', help: '服务器自带的 bot，在每个频道里，也可以私聊它；发「/指令」看它会什么。建好以后改名字、头像、签名、主页：站点管理员在客户端里和它私聊，点右上角「小助手的资料」', type: 'text', max: 32 },
    { k: 'helper.autofix', label: '打错指令自动纠正', help: '很像某个指令时直接按对的处理并说一声；删东西、花钱的指令只提示「你是不是想发…」', type: 'bool' },
    { k: 'helper.ai_url', label: '模型地址', help: 'bot 的功能共用：游戏资讯归类打分、电子厕所起名。任何 OpenAI 兼容接口，比如 https://api.deepseek.com/v1。不填也能用，只是简单些', type: 'text', placeholder: 'https://api.deepseek.com/v1' },
    { k: 'helper.ai_model', label: '模型名', type: 'text', placeholder: 'deepseek-chat' },
    { k: 'helper.ai_key', label: '模型 key', type: 'secret' },
    { k: 'helper.ai_proxy', label: '模型代理', help: '不填 = 直连', type: 'text' },
    { k: 'news.enabled', label: '游戏资讯', help: '发「/关注游戏 名字|别名」关注游戏或厂商：每小时看 Steam、B站、新闻、Reddit、YouTube、微博、贴吧、NGA，大事立刻推，每晚发汇总', type: 'bool' },
    { k: 'news.ai_url', label: '资讯单独用的模型地址', help: '不填就用上面 bot 共用的模型。都没有时不归类，只有 Steam 消息会立刻推', type: 'text' },
    { k: 'news.ai_model', label: '资讯单独用的模型名', type: 'text' },
    { k: 'news.ai_key', label: '资讯单独用的模型 key', type: 'secret' },
    { k: 'news.proxy', label: '代理', help: '访问 Google、Reddit、YouTube、Steam 用，比如 http://127.0.0.1:7890。不填 = 直连', type: 'text' },
    { k: 'news.steam_community_proxy', label: 'Steam 社区代理', help: '读厂商的 Steam 群组公告用。不填 = 和上面一样；开了加速器（Watt Toolkit）填 direct', type: 'text' },
    { k: 'news.daily_time', label: '每晚汇总时间', help: '按这台电脑的时间，比如 21:00', type: 'text', max: 5 },
    { k: 'news.steam_push', label: 'Steam 新消息立刻推送', help: '关掉就只放进每晚汇总', type: 'bool' },
    { k: 'news.max_per_conv', label: '每个频道 / 私聊最多关注几个', help: '0 表示不限', type: 'int', min: 0 },
    { k: 'news.x_weekly', label: '每周 X（推特）周报', help: '用 xAI 搜 X 上一周的讨论，按帖子收费，每个关键词约 0.3 美元', type: 'bool' },
    { k: 'news.weekly_day', label: '周报哪天发', type: 'select', options: [['sun', '周日'], ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'], ['fri', '周五'], ['sat', '周六']] },
    { k: 'news.weekly_time', label: '周报几点发', type: 'text', max: 5 },
    { k: 'news.xai_key', label: 'xAI key', type: 'secret' },
    { k: 'news.xai_model', label: 'xAI 模型', type: 'text' },
    { k: 'news.weekly_anyone', label: '谁都能用 /周报 手动查', help: '关掉时只有站点管理员能手动查（每次都要花钱）', type: 'bool' },
    { k: 'news.weibo_cookie', label: '微博 cookie', help: '建议填：登录 m.weibo.cn 后从浏览器复制 Cookie', type: 'secret' },
    { k: 'news.tieba_cookie', label: '贴吧 cookie', help: '建议填', type: 'secret' },
    { k: 'news.nga_cookie', label: 'NGA cookie', help: 'NGA 必须登录才能搜（要有 ngaPassportUid 和 ngaPassportCid）', type: 'secret' },
  ] },
  { title: '管理面板', items: [
    { k: 'admin.open_browser', label: '启动时打开管理面板', type: 'bool' },
    { k: 'admin.window', label: '用独立窗口打开', help: 'Windows 上在单独的窗口里打开面板，不用浏览器。关掉窗口服务器照样运行。', type: 'bool' },
    { k: 'admin.tray', label: '显示任务栏图标', help: 'Windows 右下角的 AM 图标', type: 'bool' },
    { k: 'admin.listen', label: '面板地址', help: '改了要退出 am-server 再打开才生效。保持 127.0.0.1 只允许本机打开。', type: 'text' },
    { k: 'log.level', label: '日志详细程度', type: 'select', options: [['debug', '调试（最详细）'], ['info', '普通'], ['warn', '只看警告'], ['error', '只看错误']] },
  ] },
];

// Server profile (shown in the client when you click the server's avatar):
// icon, description and who may edit the widgets. Saved in the database and
// applied at once, no restart.
function serverProfilePanel(page) {
  const box = el('section', { class: 'panel', 'aria-label': '服务器主页' }, el('h2', {}, '服务器主页'),
    el('p', { class: 'hint' }, '大家在客户端点服务器头像会看到这个主页。这里的改动立即生效，不用重启。'));
  load();
  return box;

  async function load() {
    let data;
    try { data = await api('GET', 'server-profile'); } catch (e) { box.append(el('p', { class: 'muted' }, e.message)); return; }
    if (currentPage !== page) return;
    const p = data.settings;
    const icon = data.icon_version
      ? el('img', { class: 'server-icon', src: 'api/server-icon?v=' + data.icon_version, alt: '服务器图标' })
      : el('span', { class: 'server-icon empty' }, '无图标');
    const file = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => file.files[0] && upload(file.files[0]) });
    const desc = el('textarea', { rows: 4, maxlength: 500, id: 'set-profile-desc', placeholder: '介绍一下这个服务器' });
    desc.value = p.description;
    const editors = el('select', { id: 'set-profile-layout' },
      [['admins', '仅管理员'], ['everyone', '所有人']].map(([v, t]) => el('option', { value: v, selected: v === p.layout_editors }, t)));
    const widget = el('input', { type: 'checkbox', checked: p.widget_content_editable, id: 'set-profile-widget' });
    const row = (id, label, help, ctl) => el('div', { class: 'setting' },
      el('div', { class: 'lbl' }, el('label', { for: id }, el('b', {}, label)), help && el('span', {}, help)),
      el('div', { class: 'ctl' }, ctl));
    box.replaceChildren(box.firstChild, box.children[1],
      el('div', { class: 'setting' },
        el('div', { class: 'lbl' }, el('b', {}, '服务器图标'), el('span', {}, '显示在客户端的服务器列表和主页上。会缩到 256 像素以内，最大 2 MB。')),
        el('div', { class: 'ctl row' }, icon, file,
          el('button', { class: 'btn small', type: 'button', onclick: () => file.click() }, '上传'),
          data.icon_version ? el('button', { class: 'btn small ghost', type: 'button', onclick: removeIcon }, '删除') : '')),
      row('set-profile-desc', '简介', '最多 500 字', desc),
      row('set-profile-layout', '谁能改布局', '摆放、增删主页上的小组件', editors),
      row('set-profile-widget', '成员能改小组件内容', '只改内容，不能改类型和位置。打开后可以给每个小组件单独设权限（小组件下一批上线）',
        el('label', { class: 'check' }, widget, el('span', {}, '开启'))),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: save }, '保存主页设置')));

    async function save() {
      try {
        await api('PUT', 'server-profile', { description: desc.value.trim(), layout_editors: editors.value, widget_content_editable: widget.checked });
        toast('主页设置已保存');
      } catch (e) { fail(e); }
    }
  }

  async function upload(f) {
    if (f.size > 2 << 20) { toast('图片太大了（最多 2 MB）', true); return; }
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(f);
    });
    try { await api('PUT', 'server-icon', { data }); toast('图标已更新'); load(); } catch (e) { fail(e); }
  }

  async function removeIcon() {
    try { await api('DELETE', 'server-icon'); toast('图标已删除'); load(); } catch (e) { fail(e); }
  }
}

async function renderSettings(root, page) {
  root.append(stateBanner() || '');
  root.append(head('设置', '改完点保存。大部分设置要重启服务器才生效，会有提示。'));
  let values;
  let loadErr = null;
  try { values = (await api('GET', 'settings')).values; } catch (e) { loadErr = e; }
  if (currentPage !== page) return;
  const inputs = {};

  if (values) {
    const form = el('form', { class: 'settings', onsubmit: (e) => { e.preventDefault(); save(); } });
    for (const g of SETTINGS) {
      form.append(el('section', { class: 'panel', 'aria-label': g.title }, el('h2', {}, g.title), g.items.map((it) => {
        let ctl;
        const v = values[it.k];
        if (it.type === 'bool') ctl = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: v }), el('span', {}, '开启'));
        else if (it.type === 'select') ctl = el('select', {}, it.options.map(([val, txt]) => el('option', { value: val, selected: val === v }, txt)));
        else ctl = el('input', { type: it.type === 'int' ? 'number' : it.type === 'secret' ? 'password' : 'text', autocomplete: it.type === 'secret' ? 'off' : null, value: v, placeholder: it.placeholder, min: it.min, max: it.type === 'int' ? it.max : null, maxlength: it.type === 'text' ? it.max : null, step: it.type === 'int' ? 1 : null });
        const input = ctl.tagName === 'LABEL' ? ctl.querySelector('input') : ctl;
        inputs[it.k] = { it, input, orig: v };
        const warn = it.warnBelow ? el('div', { class: 'warn-text', hidden: true }, '低于 ' + it.warnBelow + ' 天不符合法规要求') : null;
        if (warn) {
          const check = () => { warn.hidden = !(Number(input.value) < it.warnBelow); };
          input.addEventListener('input', check);
          check();
        }
        const id = 'set-' + it.k.replace('.', '-');
        input.id = id;
        return el('div', { class: 'setting' },
          el('div', { class: 'lbl' }, el('label', { for: id }, el('b', {}, it.label)), it.help && el('span', {}, it.help)),
          el('div', { class: 'ctl' }, ctl, warn));
      })));
    }
    if (status.autostart && status.autostart.supported) {
      const box = el('input', { type: 'checkbox', checked: status.autostart.enabled, id: 'set-autostart' });
      box.addEventListener('change', async () => {
        try {
          await api('PUT', 'autostart', { enabled: box.checked });
          toast(box.checked ? '开机后会自动启动（不会弹出浏览器）' : '已关闭开机自启');
          status.autostart.enabled = box.checked;
        } catch (e) { box.checked = !box.checked; fail(e); }
      });
      form.append(el('section', { class: 'panel', 'aria-label': 'Windows' }, el('h2', {}, 'Windows'),
        el('div', { class: 'setting' },
          el('div', { class: 'lbl' }, el('label', { for: 'set-autostart' }, el('b', {}, '开机自动启动')), el('span', {}, '登录 Windows 后在后台启动 am-server，立即生效')),
          el('div', { class: 'ctl' }, el('label', { class: 'check' }, box, el('span', {}, '开启'))))));
    }
    form.append(el('div', { class: 'savebar' },
      el('button', { class: 'btn primary', type: 'submit' }, '保存设置'),
      el('span', { class: 'hint', id: 'save-hint' }, '')));
    root.append(form);
  } else {
    root.append(el('div', { class: 'banner err' }, el('p', {}, loadErr.message)));
  }
  root.append(serverProfilePanel(page));

  // Raw config.toml editor for everything else (database, TLS, ...).
  const ta = el('textarea', { rows: 24, spellcheck: 'false', 'aria-label': 'config.toml' });
  const rawMsg = el('span', { class: 'hint' });
  const raw = el('details', { class: 'panel', open: !values },
    el('summary', {}, el('b', {}, '直接编辑 config.toml'), el('span', { class: 'hint' }, '（数据库、证书等高级设置）')),
    el('div', { class: 'stack' },
      el('p', { class: 'hint' }, '保存前会检查格式，写错了不会保存。上一个版本会备份成 config.toml.bak。'),
      ta,
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: saveRaw }, '保存 config.toml'), rawMsg)));
  root.append(raw);
  api('GET', 'config').then((r) => { ta.value = r.text; }).catch(fail);

  root.append(el('section', { class: 'panel', 'aria-label': '停止' },
    el('h2', {}, '停止服务器'),
    el('div', { class: 'row' },
      el('p', { class: 'muted spacer' }, '完全退出 am-server，所有人都会断开。之后要用的话再双击 am-server.exe。'),
      el('button', { class: 'btn danger', onclick: quitServer }, '退出 am-server'))));

  async function save() {
    const changed = {};
    for (const [k, { it, input, orig }] of Object.entries(inputs)) {
      let v;
      if (it.type === 'bool') v = input.checked;
      else if (it.type === 'int') {
        if (input.value === '' || !Number.isInteger(Number(input.value))) { input.focus(); toast(it.label + '要填整数', true); return; }
        v = Number(input.value);
      } else v = input.value.trim();
      if (v !== orig) changed[k] = v;
    }
    if (!Object.keys(changed).length) { toast('没有改动'); return; }
    try {
      await api('PUT', 'settings', { values: changed });
      for (const k of Object.keys(changed)) inputs[k].orig = changed[k];
      toast('已保存');
      await refreshStatus();
      route();
    } catch (e) { fail(e); }
  }
  async function saveRaw() {
    try {
      await api('PUT', 'config', { text: ta.value });
      rawMsg.textContent = '';
      toast('config.toml 已保存');
      await refreshStatus();
      route();
    } catch (e) { rawMsg.textContent = '没有保存：' + e.message; }
  }
}

async function quitServer() {
  if (!await confirmDialog({ title: '退出 am-server？', text: '所有人都会断开，管理面板也会关闭。', ok: '退出', danger: true })) return;
  try {
    await api('POST', 'quit');
    clearInterval(statusTimer);
    document.getElementById('app').replaceChildren(el('div', { class: 'login' }, el('div', { class: 'panel' },
      el('h1', {}, 'am-server 已退出'), el('p', { class: 'muted' }, '要再用的话，双击 am-server.exe。'))));
  } catch (e) { fail(e); }
}

start();
