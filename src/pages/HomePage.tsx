import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';

import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { DashboardGreeting } from '@/components/dashboard/DashboardGreeting';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { DashboardFooter } from '@/components/dashboard/DashboardFooter';

import { toast } from '@/hooks/use-toast';
import { broadcastAll, broadcastGirls, broadcastGoogleHome } from '@/lib/api/homeAssistant';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Volume2 } from 'lucide-react';
import { FolderOpen, Radio, Activity, Loader2, Mic, MicOff, ShoppingBasket, Users, Megaphone, Settings } from 'lucide-react';
import ballLeagueLogo from '@/assets/ball-league-logo.jpeg';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useVoiceInput } from '@/hooks/useVoiceInput';

type BroadcastStep = 'pick' | 'compose';
type BroadcastAudience = 'all' | 'google-home' | 'girls';

export default function HomePage() {
  const navigate = useNavigate();

  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastStep, setBroadcastStep] = useState<BroadcastStep>('pick');
  const [broadcastType, setBroadcastType] = useState<BroadcastAudience>('all');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastVolume, setBroadcastVolume] = useState(75);
  const [broadcasting, setBroadcasting] = useState(false);

  const { isListening, isSupported, toggleListening, stopListening: stopVoice } = useVoiceInput({
    onResult: (transcript) => setBroadcastMessage((prev) => (prev ? prev + ' ' : '') + transcript),
  });

  const openBroadcast = () => {
    setBroadcastStep('pick');
    setBroadcastType('all');
    setBroadcastMessage('');
    setBroadcastVolume(75);
    stopVoice();
    setBroadcastOpen(true);
  };

  const pickAudience = (audience: BroadcastAudience) => {
    setBroadcastType(audience);
    setBroadcastMessage('');
    // Girls broadcasts historically played at 0.9 — keep that as the default
    setBroadcastVolume(audience === 'girls' ? 90 : 75);
    setBroadcastStep('compose');
  };

  const handleCloseBroadcast = (open: boolean) => {
    if (!broadcasting) {
      if (!open) stopVoice();
      setBroadcastOpen(open);
    }
  };

  const sendBroadcast = async (message: string) => {
    if (!message.trim()) return;
    setBroadcasting(true);
    try {
      const volumeLevel = Math.min(1, Math.max(0, broadcastVolume / 100));
      if (broadcastType === 'all') {
        await broadcastAll(message, volumeLevel);
      } else if (broadcastType === 'google-home') {
        await broadcastGoogleHome(message, volumeLevel);
      } else {
        await broadcastGirls(message, volumeLevel);
      }
      toast({ title: 'Broadcast sent!' });
      setBroadcastOpen(false);
      setBroadcastMessage('');
    } catch (err) {
      toast({ title: 'Broadcast failed', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setBroadcasting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <DashboardHeader />
      <DashboardNav />

      <ErrorBoundary name="home">
      <main className="container max-w-2xl md:max-w-4xl lg:max-w-5xl py-6 space-y-6">
        <DashboardGreeting />

        <button
          onClick={() => navigate('/home-systems')}
          className="w-full glass rounded-xl px-4 py-3 flex items-center gap-3 transition-transform active:scale-[0.98]"
          data-testid="button-systems-status"
        >
          <span className="relative flex h-3 w-3">
            <span className="status-pulse absolute inline-flex h-full w-full rounded-full bg-status-ok opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-status-ok" />
          </span>
          <span className="text-sm font-medium">All Systems OK</span>
          <Activity className="ml-auto h-4 w-4 text-muted-foreground" />
        </button>

        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Actions</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button
              onClick={() => navigate('/projects')}
              className="glass rounded-xl px-4 py-4 flex items-center gap-3 transition-transform active:scale-[0.98]"
              data-testid="button-projects"
            >
              <FolderOpen className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium">Projects</span>
            </button>
            <button
              onClick={openBroadcast}
              className="glass rounded-xl px-4 py-4 flex items-center gap-3 transition-transform active:scale-[0.98]"
              data-testid="button-broadcast"
            >
              <Radio className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium">Broadcast</span>
            </button>
            <button
              onClick={() => navigate('/common-tasks/grocery')}
              className="glass rounded-xl px-4 py-4 flex items-center gap-3 transition-transform active:scale-[0.98]"
              data-testid="button-grocery"
            >
              <ShoppingBasket className="h-5 w-5 text-primary" />
              <span className="text-sm font-medium">Grocery Helper</span>
            </button>
            <button
              onClick={() => navigate('/ball')}
              className="glass rounded-xl px-4 py-4 flex items-center gap-3 transition-transform active:scale-[0.98]"
              data-testid="button-ball"
            >
              <img src={ballLeagueLogo} alt="Ball" className="h-5 w-5 rounded-full object-cover shrink-0" />
              <span className="text-sm font-medium">Ball</span>
            </button>
            <ErrorBoundary name="ball-admin-tile" fallback={<span />}>
              <BallAdminTile />
            </ErrorBoundary>
          </div>
        </div>
      </main>
      </ErrorBoundary>

      <Dialog open={broadcastOpen} onOpenChange={handleCloseBroadcast}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => { if (broadcasting) e.preventDefault(); }}>
          {broadcastStep === 'pick' && (
            <>
              <DialogHeader>
                <DialogTitle>Broadcast</DialogTitle>
                <DialogDescription>Who should Janus announce to?</DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3 pt-2">
                <Button
                  variant="outline"
                  className="h-auto py-4 justify-start gap-3"
                  onClick={() => pickAudience('all')}
                  data-testid="button-broadcast-all"
                >
                  <Megaphone className="h-5 w-5 text-primary" />
                  <div className="text-left">
                    <div className="font-medium">All Speakers and TV's</div>
                    <div className="text-xs text-muted-foreground">All speakers and TVs in the house</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="h-auto py-4 justify-start gap-3"
                  onClick={() => pickAudience('google-home')}
                  data-testid="button-broadcast-google-home"
                >
                  <Megaphone className="h-5 w-5 text-primary" />
                  <div className="text-left">
                    <div className="font-medium">All Google Home</div>
                    <div className="text-xs text-muted-foreground">All Google Home speakers & displays</div>
                  </div>
                </Button>
                <Button
                  variant="outline"
                  className="h-auto py-4 justify-start gap-3"
                  onClick={() => pickAudience('girls')}
                  data-testid="button-broadcast-girls"
                >
                  <Users className="h-5 w-5 text-primary" />
                  <div className="text-left">
                    <div className="font-medium">Girls Only</div>
                    <div className="text-xs text-muted-foreground">Isla & Emme's rooms</div>
                  </div>
                </Button>
              </div>
            </>
          )}

          {broadcastStep === 'compose' && (
            <>
              <DialogHeader>
                <DialogTitle>What should Janus say?</DialogTitle>
                <DialogDescription>
                  {broadcastType === 'all' ? 'Broadcast to everyone' : broadcastType === 'google-home' ? 'Broadcast to all Google Home speakers & displays' : 'Broadcast to the girls'}
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center gap-3 px-1 py-2">
                <Volume2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <Slider
                  min={0}
                  max={100}
                  step={5}
                  value={[broadcastVolume]}
                  onValueChange={(vals) => setBroadcastVolume(vals[0] ?? 75)}
                  disabled={broadcasting}
                  className="flex-1"
                  data-testid="slider-broadcast-volume"
                />
                <span
                  className="text-xs font-medium tabular-nums w-10 text-right text-muted-foreground"
                  data-testid="text-broadcast-volume"
                >
                  {broadcastVolume}%
                </span>
              </div>

              {(broadcastType === 'all' || broadcastType === 'google-home') && (
                <div className="flex flex-col gap-2">
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('Someone please get the door')} data-testid="button-quick-door">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Someone please get the door
                  </Button>
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('Has anyone seen Milo?')} data-testid="button-quick-milo">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Has anyone seen Milo?
                  </Button>
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('Someone please get the delivery at the door')} data-testid="button-quick-delivery">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Someone please get the delivery at the door
                  </Button>
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('A food order has arrived')} data-testid="button-quick-food">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    A food order has arrived
                  </Button>
                  <div className="relative my-1">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                    <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or custom</span></div>
                  </div>
                </div>
              )}

              {broadcastType === 'girls' && (
                <div className="flex flex-col gap-2">
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('Girls, come down')} data-testid="button-quick-comedown">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Girls, come down
                  </Button>
                  <Button variant="secondary" disabled={broadcasting} onClick={() => sendBroadcast('Check your phones')} data-testid="button-quick-phones">
                    {broadcasting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                    Check your phones
                  </Button>
                  <div className="relative my-1">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                    <div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or custom</span></div>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <Textarea
                  placeholder="Type your message…"
                  value={broadcastMessage}
                  onChange={(e) => setBroadcastMessage(e.target.value)}
                  className="min-h-[100px] flex-1"
                  disabled={broadcasting}
                  data-testid="input-broadcast-message"
                />
                {isSupported && (
                  <Button
                    type="button"
                    variant={isListening ? 'destructive' : 'outline'}
                    size="icon"
                    className="shrink-0 self-end"
                    onClick={toggleListening}
                    disabled={broadcasting}
                    data-testid="button-broadcast-mic"
                  >
                    {isListening ? <MicOff className="h-4 w-4 animate-pulse" /> : <Mic className="h-4 w-4" />}
                  </Button>
                )}
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setBroadcastStep('pick')} disabled={broadcasting} data-testid="button-broadcast-back">Back</Button>
                <Button onClick={() => sendBroadcast(broadcastMessage)} disabled={!broadcastMessage.trim() || broadcasting} data-testid="button-broadcast-send">
                  {broadcasting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Sending…</> : 'Send'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <DashboardFooter />
      <MobileBottomNav />
    </div>
  );
}

// Separate component so any hook failure (e.g. useUserProfile errors)
// gets caught by the surrounding ErrorBoundary without crashing the
// whole HomePage tree.
function BallAdminTile() {
  const profile = useUserProfile();
  if (profile.loading) return null;
  if (!profile.isAdmin) return null;
  return (
    <a
      href="/admin?section=ball"
      className="glass rounded-xl px-4 py-4 flex items-center gap-3 transition-transform active:scale-[0.98] no-underline text-inherit"
      data-testid="button-ball-admin"
    >
      <img src={ballLeagueLogo} alt="Ball Admin" className="h-5 w-5 rounded-full object-cover shrink-0" />
      <span className="text-sm font-medium">Ball Admin</span>
    </a>
  );
}
