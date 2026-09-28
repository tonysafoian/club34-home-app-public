import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { ShoppingCart, Plus, Trash2, Eye, EyeOff, Loader2 } from 'lucide-react';

const PLATFORMS = [
  { id: 'amazon', label: 'Amazon', color: 'bg-orange-500/10 text-orange-600' },
  { id: 'instacart', label: 'Instacart', color: 'bg-green-500/10 text-green-600' },
  { id: 'doordash', label: 'DoorDash', color: 'bg-red-500/10 text-red-600' },
  { id: 'postmates', label: 'Postmates', color: 'bg-blue-500/10 text-blue-600' },
];

type Credential = {
  id: string;
  platform: string;
  credential_label: string;
  encrypted_username: string;
  created_at: string;
};

async function vaultRequest(action: string, body?: object) {
  return apiClient.invokeFn('credential-vault', { action, ...body });
}

export default function PlatformCredentialsCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const fetchCredentials = useCallback(async () => {
    if (!user) return;
    const { data } = await apiClient.dbQuery<Credential[]>({
      table: 'user_platform_credentials',
      select: 'id, platform, credential_label, encrypted_username, created_at',
      filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
      order: { column: 'created_at', ascending: true },
    });
    if (data) setCredentials(data);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchCredentials();
  }, [fetchCredentials]);

  const handleSave = async () => {
    if (!selectedPlatform || !username || !password) return;
    setSaving(true);

    try {
      await vaultRequest('save-platform-credential', {
        platform: selectedPlatform,
        username,
        password,
        credential_label: PLATFORMS.find(p => p.id === selectedPlatform)?.label || selectedPlatform,
      });

      toast({ title: 'Saved', description: `${selectedPlatform} credentials saved securely.` });
      setShowForm(false);
      setSelectedPlatform('');
      setUsername('');
      setPassword('');
      fetchCredentials();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to save';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string, platform: string) => {
    try {
      await apiClient.dbDelete('user_platform_credentials', [{ column: 'id', op: 'eq', value: id }]);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
      return;
    }
    toast({ title: 'Deleted', description: `${platform} credentials removed.` });
    fetchCredentials();
  };

  const savedPlatforms = credentials.map(c => c.platform);
  const availablePlatforms = PLATFORMS.filter(p => !savedPlatforms.includes(p.id));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <ShoppingCart className="w-5 h-5 text-accent" />
          </div>
          <div className="flex-1">
            <CardTitle>Platform Logins</CardTitle>
            <CardDescription>
              Store your credentials for shopping platforms. Janus can use these to help build carts.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {credentials.length > 0 && (
              <div className="space-y-2">
                {credentials.map((cred) => {
                  const platform = PLATFORMS.find(p => p.id === cred.platform);
                  return (
                    <div
                      key={cred.id}
                      className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <Badge variant="secondary" className={platform?.color}>
                          {platform?.label || cred.platform}
                        </Badge>
                        <span className="text-sm text-muted-foreground">{cred.encrypted_username.slice(0, 8)}…</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDelete(cred.id, cred.platform)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {showForm ? (
              <div className="space-y-3 rounded-lg border border-border p-4">
                <div className="space-y-2">
                  <Label>Platform</Label>
                  <div className="flex flex-wrap gap-2">
                    {availablePlatforms.map((p) => (
                      <Button
                        key={p.id}
                        variant={selectedPlatform === p.id ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSelectedPlatform(p.id)}
                      >
                        {p.label}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="plat-user">Email / Username</Label>
                  <Input
                    id="plat-user"
                    placeholder="your@email.com"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="plat-pass">Password</Label>
                  <div className="relative">
                    <Input
                      id="plat-pass"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="••••••••"
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
                      {showPassword ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                    </Button>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button onClick={handleSave} disabled={!selectedPlatform || !username || !password || saving}>
                    {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> : 'Save'}
                  </Button>
                  <Button variant="outline" onClick={() => { setShowForm(false); setSelectedPlatform(''); setUsername(''); setPassword(''); }}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : availablePlatforms.length > 0 ? (
              <Button variant="outline" className="w-full" onClick={() => setShowForm(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add Platform Login
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-2">All platforms configured ✓</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
