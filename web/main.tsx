import { render } from 'preact';
import { App } from './app';
import './styles.css';

const root = document.getElementById('app');
if (root) render(<App />, root);

// Register the service worker on load so the app is installable (and push works
// on a later opt-in). Registration is idempotent, so the push flow can call it
// again safely.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // best-effort; the app works uninstalled without a service worker
    });
  });
}
