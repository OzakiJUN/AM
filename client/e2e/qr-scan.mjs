// The camera QR scanner (app/QrScanner.tsx) against a fake camera that
// shows a join-code QR: it reads the code and closes; without camera
// permission it says so; ✕ closes with null. Run from client/ with
// playwright installed (CI does): node e2e/qr-scan.mjs
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createServer } from 'vite';
const { chromium } = await import(process.env.AM_TEST_PLAYWRIGHT ?? 'playwright');

const CODE = 'AM1-AHF5-2ZS5-XP7X-7S2A-VP8S-3N77-7MR9-J6S';
const client = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(client, `.qr-test-${process.pid}`);
mkdirSync(dir);

// A y4m video (what Chromium's fake camera plays): the QR on white, 640×480.
function y4m(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const W = 640, H = 480, cell = Math.floor(360 / (n + 8));
  const x0 = Math.floor((W - cell * n) / 2), y0 = Math.floor((H - cell * n) / 2);
  const Y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    for (let y = 0; y < cell; y++) Y.fill(16, (y0 + r * cell + y) * W + x0 + c * cell, (y0 + r * cell + y) * W + x0 + (c + 1) * cell);
  }
  const UV = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420\n`), ...Array(10).fill(frame)]);
}
const video = join(tmpdir(), `am-qr-${process.pid}.y4m`);
writeFileSync(video, y4m(CODE));
writeFileSync(resolve(dir, 'index.html'), '<html lang="zh"><meta charset="UTF-8"><div id="root"></div><script type="module" src="./main.tsx"></script></html>');
writeFileSync(resolve(dir, 'main.tsx'), `
import { createRoot } from 'react-dom/client';
import { QrScannerHost } from '../src/app/QrScanner';
import { scanQRCamera } from '../src/lib/platform';
import '../src/styles.css';
createRoot(document.getElementById('root')!).render(<QrScannerHost />);
(window as any).scan = () => scanQRCamera().then((t) => ((window as any).result = t));
`);

let server, browser;
try {
  server = await createServer({ root: client, server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const url = server.resolvedUrls.local[0] + dir.split('/').at(-1) + '/index.html';
  browser = await chromium.launch({
    executablePath: process.env.AM_TEST_CHROMIUM,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 } });
  await ctx.grantPermissions(['camera']);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.evaluate(() => window.scan());
  await p.getByRole('dialog', { name: '扫一扫' }).waitFor();
  await p.waitForFunction(() => window.result !== undefined, null, { timeout: 20000 });
  assert.equal(await p.evaluate(() => window.result), CODE);
  await p.getByRole('dialog', { name: '扫一扫' }).waitFor({ state: 'detached' });

  // No permission: a clear message; ✕ closes with null.
  const p2 = await ctx.newPage();
  await p2.goto(url);
  await p2.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    window.scan();
  });
  assert.match(await p2.getByRole('alert').innerText(), /没有相机权限/);
  await p2.getByRole('button', { name: '关闭' }).click();
  await p2.waitForFunction(() => window.result !== undefined);
  assert.equal(await p2.evaluate(() => window.result), null);
  assert.deepEqual(errors, []);
  console.log('qr scan ok');
} finally {
  await browser?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(video, { force: true });
}
