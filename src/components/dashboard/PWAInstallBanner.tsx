import { usePWAInstall } from '@/hooks/usePWAInstall';
import { Button } from '@/components/ui/button';
import { Download, X, Share, PlusSquare } from 'lucide-react';
import { useState } from 'react';

export function PWAInstallBanner() {
  const { canInstall, isInstalled, isIOS, install } = usePWAInstall();
  const [dismissed, setDismissed] = useState(() => {
    return sessionStorage.getItem('pwa-banner-dismissed') === 'true';
  });

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('pwa-banner-dismissed', 'true');
  };

  const handleInstall = async () => {
    await install();
  };

  if (isInstalled || dismissed) return null;
  if (!canInstall && !isIOS) return null;

  return (
    <div className="relative rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center gap-4">
      <button
        onClick={handleDismiss}
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      {canInstall ? (
        <>
          <Download className="h-8 w-8 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">Install Janus</p>
            <p className="text-xs text-muted-foreground">
              Add to your home screen for instant access & offline support.
            </p>
          </div>
          <Button size="sm" onClick={handleInstall} className="shrink-0">
            Install
          </Button>
        </>
      ) : isIOS ? (
        <>
          <Download className="h-8 w-8 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">Install Janus</p>
            <p className="text-xs text-muted-foreground">
              Tap <Share className="inline h-3.5 w-3.5" /> then <strong>Add to Home Screen</strong> <PlusSquare className="inline h-3.5 w-3.5" />
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
