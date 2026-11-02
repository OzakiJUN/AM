import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { boot } from './lib/store';
import { startSync } from './lib/sync';
import { startStickerSync } from './lib/stickerSync';
import { startDevices } from './lib/devices';
import { startAI } from './lib/ai/runner';
import { startAgentKeys } from './lib/ai/agentState';
import { watchTheme } from './lib/theme';
import { watchClosePref } from './lib/prefs';
import { readHostConfig, runHost } from './lib/ai/host';
import { startUpdates } from './lib/update';
import './styles.css';

// Host mode (am-server runs one AI with this client, no window): nothing else starts.
void readHostConfig().then((host) => {
  if (host) {
    void runHost(host).catch((e) => console.error('host mode', e));
    return;
  }
  watchTheme();
  boot();
  startSync();
  startStickerSync();
  startDevices();
  startAI();
  startAgentKeys();
  watchClosePref();
  startUpdates();
  // No browser context menu (we show our own); keep it for text fields.
  window.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (!t.closest('input, textarea')) e.preventDefault();
  });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
