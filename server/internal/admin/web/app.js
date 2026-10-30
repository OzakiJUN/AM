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

function dialog(build) {
  return new Promise((resolve) => {
    const d = el('dialog');
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
            : u.online ? el('span', { class: 'online' }, '在线') : el('span', { class: 'muted' }, fmtAgo(u.last_seen))),
        el('td', {}, fmtTime(u.created_at)),
        el('td', { class: 'actions' },
          el('button', { class: 'btn small ghost', onclick: () => showLogins(u) }, '登录记录'),
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
  root.append(head('频道记录', '所有频道（公开和私密）的聊天记录，只能看不能改。私信看不到。打开某个频道会记入操作记录。', search), box);
  async function load() {
    let data;
    try { data = await api('GET', 'channels?q=' + encodeURIComponent(channelQuery) + '&page=' + channelPage); } catch (e) { fail(e); return; }
    if (currentPage !== page) return;
    if (!data.items.length) {
      box.replaceChildren(el('div', { class: 'table-wrap' }, el('p', { class: 'empty' }, channelQuery ? '没有找到匹配的频道' : '还没有频道。')));
      return;
    }
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['频道', '人数', '记录数', '创建时间', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, data.items.map((c) => el('tr', {},
        el('td', {},
          el('b', {}, c.name),
          el('span', { class: 'tag' + (c.public ? '' : ' warn') }, c.public ? '公开' : '私密'),
          c.dissolved && el('span', { class: 'tag bad' }, '已解散'),
          c.owner_name && el('span', { class: 'sub' }, '频道主：' + c.owner_name)),
        el('td', {}, c.members),
        el('td', {}, c.messages),
        el('td', {}, fmtTime(c.created_at)),
        el('td', { class: 'actions' }, el('a', { class: 'btn small ghost', href: '#/channels/' + c.id }, '查看记录'))))))),
    pager(data.total, data.page_size, channelPage, (p) => { channelPage = p; load(); }));
  }
  load();
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

// ---------- audit ----------

const AUDIT_TEXT = {
  admin_delete: '删除了一条消息', kick: '把人移出了群', mute: '禁言了', transfer: '转让了群',
  dissolve: '解散了群', ban: '封禁了', unban: '解封了', site_admin_grant: '设为站点管理员：',
  site_admin_remove: '取消了站点管理员：', password_reset: '重置了密码：', invite_create: '生成了邀请码',
  invite_delete: '作废了邀请码', channel_view: '在管理面板查看了聊天记录',
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
  ] },
  { title: '留存', items: [
    { k: 'retention.evidence_days', label: '删除记录保留天数', help: '被删除消息的原内容保留多久，法规要求至少 180 天', type: 'int', min: 1, warnBelow: 180 },
    { k: 'retention.login_record_days', label: '登录记录保留天数', help: '登录时间、IP、设备，法规要求至少 180 天', type: 'int', min: 1, warnBelow: 180 },
  ] },
  { title: '图片黑名单', items: [
    { k: 'media.block_distance', label: '相似度容差', help: '0–64，越小越严格。6 能拦住改过尺寸或重新压缩的同一张图。', type: 'int', min: 0, max: 64 },
  ] },
  { title: '管理面板', items: [
    { k: 'admin.open_browser', label: '启动时打开管理面板', type: 'bool' },
    { k: 'admin.window', label: '用独立窗口打开', help: 'Windows 上在单独的窗口里打开面板，不用浏览器。关掉窗口服务器照样运行。', type: 'bool' },
    { k: 'admin.tray', label: '显示任务栏图标', help: 'Windows 右下角的 AM 图标', type: 'bool' },
    { k: 'admin.listen', label: '面板地址', help: '改了要退出 am-server 再打开才生效。保持 127.0.0.1 只允许本机打开。', type: 'text' },
    { k: 'log.level', label: '日志详细程度', type: 'select', options: [['debug', '调试（最详细）'], ['info', '普通'], ['warn', '只看警告'], ['error', '只看错误']] },
  ] },
];

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
        else ctl = el('input', { type: it.type === 'int' ? 'number' : 'text', value: v, placeholder: it.placeholder, min: it.min, max: it.type === 'int' ? it.max : null, maxlength: it.type === 'text' ? it.max : null, step: it.type === 'int' ? 1 : null });
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
