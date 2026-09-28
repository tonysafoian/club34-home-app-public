import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ShoppingCart, Loader2, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { useAmazonSettings } from '@/hooks/useAmazonSettings';

export default function AmazonSettingsCard() {
  const { settings, loading, saving, saveSettings, deleteSettings, isConfigured } = useAmazonSettings();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (settings) {
      setEmail(settings.amazon_email || '');
    }
  }, [settings]);

  useEffect(() => {
    const emailChanged = email !== (settings?.amazon_email || '');
    const passwordEntered = password.length > 0;
    setHasChanges(emailChanged || passwordEntered);
  }, [email, password, settings]);

  const handleSave = async () => {
    if (!email || !password) return;
    const result = await saveSettings(email, password);
    if (result.success) {
      setPassword('');
      setHasChanges(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <ShoppingCart className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              Amazon Account
              {isConfigured && (
                <span className="flex items-center gap-1 text-xs font-normal text-primary">
                  <CheckCircle2 className="w-3 h-3" />
                  Configured
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Shared Amazon account used for automated ordering
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="amazon-email">Amazon Email</Label>
          <Input
            id="amazon-email"
            type="email"
            placeholder="amazon-account@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="amazon-password">Amazon Password</Label>
          <div className="relative">
            <Input
              id="amazon-password"
              type={showPassword ? 'text' : 'password'}
              placeholder={isConfigured ? '••••••••••••••••' : 'Enter Amazon password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-10"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Password is stored encrypted. All order automations use this account.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 pt-4 border-t">
          <Button onClick={handleSave} disabled={!email || !password || saving}>
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              'Save Amazon Account'
            )}
          </Button>

          {isConfigured && (
            <Button variant="destructive" onClick={deleteSettings} disabled={saving}>
              Disconnect
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
