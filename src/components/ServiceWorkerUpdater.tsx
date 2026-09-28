import { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { X, RefreshCw } from 'lucide-react';

export function ServiceWorkerUpdater() {
  const location = useLocation();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let refreshing = false;

    const onControllerChange = () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        navigator.serviceWorker.getRegistration().then(r => r?.update());
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    const interval = setInterval(() => {
      navigator.serviceWorker.getRegistration().then(r => r?.update());
    }, 60_000);

    let regRef: ServiceWorkerRegistration | undefined;
    const onUpdateFound = () => {
      const sw = regRef?.installing;
      if (!sw) return;
      const onStateChange = () => {
        if (sw.state === 'installed') {
          if (navigator.serviceWorker.controller) {
            setWaitingWorker(sw);
          } else {
            sw.postMessage({ type: 'SKIP_WAITING' });
          }
          sw.removeEventListener('statechange', onStateChange);
        }
      };
      sw.addEventListener('statechange', onStateChange);
    };

    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return;
      regRef = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(reg.waiting);
      } else if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      reg.addEventListener('updatefound', onUpdateFound);
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
      regRef?.removeEventListener('updatefound', onUpdateFound);
    };
  }, []);

  useEffect(() => {
    setDismissed(false);
  }, [location.key]);

  const handleReload = useCallback(() => {
    if (!waitingWorker) return;
    setReloading(true);
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, [waitingWorker]);

  if (!waitingWorker || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="banner-update-available"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] max-w-[calc(100%-2rem)] flex items-center gap-3 rounded-lg border bg-background/95 backdrop-blur px-4 py-3 shadow-lg"
    >
      <RefreshCw className="h-4 w-4 text-primary shrink-0" />
      <span className="text-sm">A new version is available</span>
      <Button
        size="sm"
        onClick={handleReload}
        disabled={reloading}
        data-testid="button-reload-update"
      >
        {reloading ? 'Reloading…' : 'Reload now'}
      </Button>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        data-testid="button-dismiss-update"
        className="ml-1 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
