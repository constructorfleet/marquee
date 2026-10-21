import { registerSW } from 'virtual:pwa-register';

// A new release installs in the background, then the page switches over at a
// moment that can't lose anything: the next in-app navigation, a click on the
// "new version ready" notice, or straight away on Poster Mode (a display with
// nothing to type into). Never by itself mid-form.

const CHECK_EVERY_MS = 30 * 60_000;

let activate: ((reloadPage?: boolean) => Promise<void>) | null = null;
let ready = false;
const listeners = new Set<(ready: boolean) => void>();

const isPosterMode = () => window.location.pathname.startsWith('/poster');

export function startUpdateChecks() {
  activate = registerSW({
    immediate: true,
    onNeedRefresh() {
      ready = true;
      listeners.forEach((listener) => listener(true));
      if (isPosterMode()) applyUpdate();
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;
      // Browsers only look for a new version on a full page load. Installed apps
      // stay open for days, so also look on return to the foreground — and on a
      // timer, for wall displays that never leave it.
      const check = () => registration.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      setInterval(check, CHECK_EVERY_MS);
    },
  });
}

// Switch to the waiting release (reloads the page). No-op until one is ready.
export function applyUpdate() {
  if (ready) void activate?.(true);
}

export function onUpdateReady(listener: (ready: boolean) => void): () => void {
  listeners.add(listener);
  listener(ready);
  return () => listeners.delete(listener);
}
