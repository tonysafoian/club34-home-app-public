import { usePWAInstall } from '@/hooks/usePWAInstall';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { JanusLogo } from '@/components/brand/JanusLogo';
import { Download, CheckCircle, Share, PlusSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function Install() {
  const { canInstall, isInstalled, isIOS, install } = usePWAInstall();
  const navigate = useNavigate();

  const handleInstall = async () => {
    const accepted = await install();
    if (accepted) {
      navigate('/');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden" style={{ background: '#141519' }}>
      <div
        className="absolute -top-32 -left-32 w-96 h-96 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #f1a32914 0%, transparent 70%)' }}
      />
      <div
        className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #c56a1d0d 0%, transparent 70%)' }}
      />

      <Card className="w-full max-w-md glass relative z-10 janus-glow-soft">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto janus-glow rounded-full">
            <JanusLogo size="xl" variant="icon" />
          </div>
          <div>
            <CardTitle className="text-3xl font-display janus-text-gradient">
              Install Janus
            </CardTitle>
            <CardDescription className="mt-2 font-body text-muted-foreground">
              Add to your home screen for instant access
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {isInstalled ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <CheckCircle className="h-12 w-12 text-primary" />
              <p className="text-sm text-muted-foreground text-center">
                Janus is already installed on this device.
              </p>
              <Button onClick={() => navigate('/')} className="mt-2">
                Open App
              </Button>
            </div>
          ) : canInstall ? (
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-muted-foreground text-center">
                Install Janus as an app for faster access, offline support, and a full-screen experience.
              </p>
              <Button onClick={handleInstall} size="lg" className="w-full gap-2">
                <Download className="h-5 w-5" />
                Install App
              </Button>
            </div>
          ) : isIOS ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                To install on your iPhone or iPad:
              </p>
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <Share className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <span>Tap the <strong>Share</strong> button in Safari's toolbar</span>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <PlusSquare className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <span>Scroll down and tap <strong>Add to Home Screen</strong></span>
                </div>
                <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                  <CheckCircle className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                  <span>Tap <strong>Add</strong> to confirm</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-sm text-muted-foreground text-center">
                Open this page in Chrome or Safari to install Janus as an app.
              </p>
            </div>
          )}

          {!isInstalled && (
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => navigate('/')}
            >
              Continue in browser
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
