// Exercise the public notifier, including the native handoff and browser fallback.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const names = ['window', 'document', 'Notification', 'localStorage', '__amNotifyTest'];
const saved = new Map(names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
const state = { nativeCalls: [], nativeHandled: true, sent: [], permission: 'granted', enabled: true };
globalThis.__amNotifyTest = state;
globalThis.localStorage = { getItem: () => state.enabled ? 'on' : 'off' };
globalThis.document = { visibilityState: 'visible', hasFocus: () => { throw Error('focus must not control notifications'); } };
const server = await createServer({ ssr: { noExternal: ['@tauri-apps/api', '@tauri-apps/plugin-notification'] }, server: { middlewareMode: true, hmr: false }, plugins: [{
  name: 'notification-test-platform', enforce: 'pre',
  resolveId(id) { if (id === '@tauri-apps/api/core' || id === '@tauri-apps/plugin-notification') return '\0' + id; },
  load(id) {
    if (id === '\0@tauri-apps/api/core') return `export async function invoke(name,args){const s=globalThis.__amNotifyTest;s.nativeCalls.push({name,args});return s.nativeHandled;}`;
    if (id === '\0@tauri-apps/plugin-notification') return `export async function isPermissionGranted(){return globalThis.__amNotifyTest.permission==='granted'};export async function requestPermission(){return globalThis.__amNotifyTest.permission};export function sendNotification(n){globalThis.__amNotifyTest.sent.push(n)}`;
  },
}] });
try {
  globalThis.window = { __TAURI_INTERNALS__: {} };
  const native = await server.ssrLoadModule('/src/lib/platform.ts?native-notification-test');
  assert.equal(await native.notify('其他聊天的新消息', 'text'), undefined);
  assert.deepEqual(state.nativeCalls.at(-1), { name: 'windows_notify', args: { title: '其他聊天的新消息', body: 'text', force: false } });
  assert.equal(state.sent.length, 0); // native handled the visible-window suppression
  await native.notify('AM 通知测试', 'test', { force: true });
  assert.equal(state.nativeCalls.at(-1).args.force, true);
  // A minimized/hidden native window can retain a stale "visible" WebView state.
  // Native policy controls this, so the plugin fallback must still be allowed.
  state.nativeHandled = false;
  await native.notify('tray', 'new message');
  assert.equal(state.sent.length, 1);
  state.permission = 'denied';
  assert.match(await native.notify('tray', 'new message'), /系统未允许/);
  state.enabled = false;
  const before = state.nativeCalls.length;
  await native.notify('disabled', 'text', { force: true });
  assert.equal(state.nativeCalls.length, before);

  state.enabled = true; state.permission = 'granted'; state.sent.length = 0;
  class NotificationMock {
    static permission = 'granted';
    static async requestPermission() { return NotificationMock.permission; }
    constructor(title, options) { state.sent.push({ title, ...options }); }
  }
  globalThis.Notification = NotificationMock;
  globalThis.window = { Notification: NotificationMock };
  const web = await server.ssrLoadModule('/src/lib/platform.ts?browser-notification-test');
  await web.notify('another conversation', 'text');
  assert.equal(state.sent.length, 0); // visible, unfocused, another chat: still quiet
  globalThis.document.visibilityState = 'hidden';
  await web.notify('hidden window', 'text');
  assert.equal(state.sent.length, 1);
  globalThis.document.visibilityState = 'visible';
  await web.notify('manual settings test', 'text', { force: true });
  assert.equal(state.sent.length, 2);
  NotificationMock.permission = 'denied';
  globalThis.document.visibilityState = 'hidden';
  assert.match(await web.notify('denied', 'text'), /浏览器未允许/);
  console.log('notifications: visible windows quiet, hidden/minimized fallback, explicit test and preference respected');
} finally {
  await server.close();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
