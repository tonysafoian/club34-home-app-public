import { useState, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { useHomeAssistant } from '@/hooks/useHomeAssistant';
import { useUserRole } from '@/hooks/useUserRole';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Home, Loader2, CheckCircle2, XCircle, Eye, EyeOff, ExternalLink, RefreshCw, BookOpen, HelpCircle } from 'lucide-react';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import AmazonSettingsCard from '@/components/settings/AmazonSettingsCard';
import GoogleServicesCard from '@/components/settings/GoogleServicesCard';
import GoAccessGoogleCard from '@/components/settings/GoAccessGoogleCard';
import PlatformCredentialsCard from '@/components/settings/PlatformCredentialsCard';
import BrandingSettingsCard from '@/components/settings/BrandingSettingsCard';
import HouseholdMembersCard from '@/components/settings/HouseholdMembersCard';
import { hardReload } from '@/lib/errorReporter';

export default function Settings() {
  const navigate = useNavigate();
  const { isAdmin } = useUserRole();
  const { settings, loading, saving, testing, saveSettings, testConnection, disconnect } = useHomeAssistant();
  
  const [haUrl, setHaUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefreshApp = async () => {
    setRefreshing(true);
    await hardReload();
  };

  useEffect(() => {
    if (settings) {
      setHaUrl(settings.ha_url || '');
    }
  }, [settings]);

  useEffect(() => {
    const urlChanged = haUrl !== (settings?.ha_url || '');
    const tokenEntered = accessToken.length > 0;
    setHasChanges(urlChanged || tokenEntered);
  }, [haUrl, accessToken, settings]);

  const handleSave = async () => {
    if (!haUrl) return;
    const result = await saveSettings(haUrl, accessToken);
    if (result.success) {
      setAccessToken('');
      setHasChanges(false);
    }
  };

  const handleTest = async () => {
    if (!haUrl) return;
    // Pass the newly entered token if any; when empty, the server falls back
    // to the stored (encrypted) token or its env configuration.
    await testConnection(haUrl, accessToken);
  };

  const handleDisconnect = async () => {
    await disconnect();
    setHaUrl('');
    setAccessToken('');
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-muted-foreground">Configure your integrations</p>
          </div>
        </div>
      </header>

      <ErrorBoundary name="settings">
      <main className="container py-6 space-y-6">
        {/* Getting Started & Configuration Guide Banner */}
        <Card className="border-primary/20 bg-gradient-to-r from-primary/10 via-card to-card">
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center text-primary shrink-0">
                  <BookOpen className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">First-Time Setup & Configuration Guide</CardTitle>
                  <CardDescription>
                    Step-by-step instructions for Gemini AI, Google Calendars, and household customization.
                  </CardDescription>
                </div>
              </div>
              <a
                href="https://github.com/tonysafoian/janus-home-app/blob/main/docs/CONFIGURATION_GUIDE.md"
                target="_blank"
                rel="noreferrer"
                className="shrink-0"
              >
                <Button variant="outline" size="sm" className="gap-1.5 w-full sm:w-auto">
                  <span>Full One-Pager Guide</span>
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </a>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="faq-1" className="border-b-0 border-t border-border/50">
                <AccordionTrigger className="text-xs font-medium text-muted-foreground hover:text-foreground py-2.5">
                  <span className="flex items-center gap-2">
                    <HelpCircle className="h-3.5 w-3.5 text-primary" />
                    How do I get the free Google Gemini AI Key? (Takes 60 seconds)
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed pl-5 pb-3 space-y-1.5">
                  <p>
                    1. Go to <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-primary underline">Google AI Studio</a> and sign in with any Google account.
                  </p>
                  <p>
                    2. Click <strong>Get API key</strong> in the top navigation, then <strong>Create API key</strong>.
                  </p>
                  <p>
                    3. Copy the key (starts with <code className="text-amber-400">AIzaSy...</code>).
                  </p>
                  <p>
                    4. In Home Assistant, open <strong>Settings ➔ Add-ons ➔ Janus ➔ Configuration</strong> tab.
                  </p>
                  <p>
                    5. Paste the key into <code className="text-amber-400">gemini_api_key</code>, click <strong>Save</strong>, and restart the Janus add-on!
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="faq-2" className="border-b-0 border-t border-border/50">
                <AccordionTrigger className="text-xs font-medium text-muted-foreground hover:text-foreground py-2.5">
                  <span className="flex items-center gap-2">
                    <HelpCircle className="h-3.5 w-3.5 text-primary" />
                    Do I need Google Sign-In or can I use Local Access Mode?
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed pl-5 pb-3 space-y-1.5">
                  <p>
                    <strong>Local Access Mode is all you need for 100% smart home control!</strong> All your lights, climate zones, locks, switches, floor plans, and Gemini voice AI work completely locally with zero cloud dependencies.
                  </p>
                  <p>
                    Google Sign-In is completely optional and only needed if you want Janus to sync your family's Google Calendar for morning schedule digests.
                  </p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="faq-3" className="border-b-0 border-t border-border/50">
                <AccordionTrigger className="text-xs font-medium text-muted-foreground hover:text-foreground py-2.5">
                  <span className="flex items-center gap-2">
                    <HelpCircle className="h-3.5 w-3.5 text-primary" />
                    How do I add family members or rename the estate?
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed pl-5 pb-3">
                  Use the <strong>Household & Family Members</strong> and <strong>Estate Branding & Appearance</strong> cards directly below on this page. Everything is 100% graphical — you never need to write YAML or edit configuration files.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>

        {/* Estate Branding & Appearance Customizer */}
        <BrandingSettingsCard />

        {/* Household & Family Members */}
        <HouseholdMembersCard />

        {/* Home Assistant Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Home className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle>Home Assistant</CardTitle>
                  <CardDescription>Connect to your Home Assistant instance</CardDescription>
                </div>
              </div>
              {settings?.is_connected ? (
                <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/20">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">
                  <XCircle className="h-3 w-3 mr-1" /> Not connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="ha-url">Home Assistant URL</Label>
              <Input
                id="ha-url"
                placeholder="http://homeassistant.local:8123"
                value={haUrl}
                onChange={(e) => setHaUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ha-token">Long-Lived Access Token</Label>
              <div className="flex gap-2">
                <Input
                  id="ha-token"
                  type={showToken ? 'text' : 'password'}
                  placeholder="Enter new token…"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  className="flex-1"
                />
                <Button variant="outline" size="icon" onClick={() => setShowToken(!showToken)}>
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSave} disabled={saving || !hasChanges}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save
              </Button>
              <Button variant="outline" onClick={handleTest} disabled={testing || !haUrl}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Test Connection
              </Button>
              {settings?.is_connected && (
                <Button variant="destructive" onClick={handleDisconnect}>
                  Disconnect
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Connected Services */}
        <GoogleServicesCard />
        <GoAccessGoogleCard />

        {/* Platform Credentials - available to all users */}
        <PlatformCredentialsCard />

        {/* Amazon Account - Admin Only */}
        {isAdmin && <AmazonSettingsCard />}

        {/* Build version footer */}
        <footer className="flex justify-center pt-2 pb-[env(safe-area-inset-bottom)]">
          <button
            type="button"
            onClick={handleRefreshApp}
            disabled={refreshing}
            title="Tap to clear cached files and reload the latest version"
            data-testid="button-build-version"
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Build v{__BUILD_VERSION__}</span>
          </button>
        </footer>
      </main>
      </ErrorBoundary>
    </div>
  );
}
