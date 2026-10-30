import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { boot } from './lib/store';
import { startSync } from './lib/sync';
import { watchTheme } from './lib/theme';
import './styles.css';

watchTheme();
boot();
startSync();
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
