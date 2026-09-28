import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { recoverIfStylesheetsFailed, clearRecoveryBudget } from "./lib/errorReporter";

// After all subresources have settled, detect the "rendered but unstyled"
// failure mode (stale SW navigation cache serving an old index.html whose CSS
// hash 404s) and self-heal via a throttled hard reload.
window.addEventListener('load', () => {
  recoverIfStylesheetsFailed();

  // Confirmed successful boot: clear the chunk-recovery budget so a device
  // that self-healed from a stale deploy gets a fresh slate for the next one.
  // We wait 8 seconds to be confident the app is rendering cleanly (not about
  // to hit a lazy-chunk error on first navigation) before wiping the counter.
  setTimeout(() => {
    clearRecoveryBudget();
  }, 8_000);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

    // Purge any lingering navigation runtime caches from prior builds.
    // The SW now uses NetworkOnly for navigations (no new navigation
    // caches are created), so any "navigation-cache-*" entry is stale
    // and can be deleted unconditionally.
    if ('caches' in self) {
      caches.keys().then((keys) => {
        for (const key of keys) {
          if (key.startsWith('navigation-cache-')) {
            caches.delete(key).catch(() => {});
          }
        }
      }).catch(() => {});
    }
  });
}

createRoot(document.getElementById("root")!).render(<App />);
