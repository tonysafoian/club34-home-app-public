import { useState, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { useHomeAssistant } from '@/hooks/useHomeAssistant';
import { useUserRole } from '@/hooks/useUserRole';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowLeft, Home, Loader2, CheckCircle2, XCircle, Eye, EyeOff, ExternalLink, RefreshCw } from 'lucide-react';
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
