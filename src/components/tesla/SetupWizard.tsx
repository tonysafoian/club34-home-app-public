import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useTesla } from '@/hooks/useTesla';

export function SetupWizard() {
  const { loading, status, fetchStatus, generateKeypair, registerPartner, getAuthUrl } = useTesla();
  const { toast } = useToast();
  const [publicKeyPem, setPublicKeyPem] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleGenerateKey = async () => {
    const result = await generateKeypair();
    if (result?.public_key_pem) {
      setPublicKeyPem(result.public_key_pem);
    }
    await fetchStatus();
  };

  const handleRegister = async () => {
    await registerPartner();
    await fetchStatus();
  };

  const handleAuth = async () => {
    const url = await getAuthUrl();
    if (url) window.location.href = url;
  };

  const copyKey = () => {
    if (publicKeyPem) {
      navigator.clipboard.writeText(publicKeyPem);
      toast({ title: 'Copied to clipboard' });
    }
  };

  if (!status) {
    return (
      <Card className="glass">
        <CardContent className="py-8">
          <Skeleton className="h-4 w-48 mb-4" />
          <Skeleton className="h-4 w-64" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="font-display flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-[hsl(var(--status-warning))]" />
          Tesla Fleet API Setup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && !status.credentials_configured && (
          <div className="rounded-md border border-[hsl(var(--status-warning))] bg-[hsl(var(--status-warning)/0.1)] p-3" data-testid="alert-credentials-missing">
            <p className="text-sm font-medium text-[hsl(var(--status-warning))]">Tesla API Credentials Missing</p>
            <p className="text-xs text-muted-foreground mt-1">
              TESLA_CLIENT_ID and TESLA_CLIENT_SECRET must be configured as environment secrets before setup can proceed.
              These are obtained from the <a href="https://developer.tesla.com" target="_blank" rel="noopener noreferrer" className="underline text-primary">Tesla Developer Portal</a>.
            </p>
          </div>
        )}

        {/* Step 1: Generate Keypair */}
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${status.keypair_generated ? 'bg-[hsl(var(--status-online))] text-white' : 'bg-muted text-muted-foreground'}`}>
            {status.keypair_generated ? <CheckCircle className="h-4 w-4" /> : '1'}
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">Generate EC Keypair</p>
            <p className="text-xs text-muted-foreground mb-2">Creates a P-256 keypair for Tesla vehicle command signing.</p>
            {!status.keypair_generated && (
              <Button size="sm" onClick={handleGenerateKey} disabled={loading}>
                Generate Keypair
              </Button>
            )}
            {publicKeyPem && (
              <div className="mt-2">
                <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-32">{publicKeyPem}</pre>
                <Button size="sm" variant="outline" onClick={copyKey} className="mt-2 gap-1">
                  <Copy className="h-3 w-3" /> Copy Public Key
                </Button>
                <p className="text-xs text-muted-foreground mt-2">
                  Host this at: <code className="text-[hsl(var(--club34-amber))]">https://{import.meta.env.VITE_APP_DOMAIN || "example.com"}/.well-known/appspecific/com.tesla.3p.public-key.pem</code>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Register Partner */}
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${status.partner_registered ? 'bg-[hsl(var(--status-online))] text-white' : 'bg-muted text-muted-foreground'}`}>
            {status.partner_registered ? <CheckCircle className="h-4 w-4" /> : '2'}
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">Register Partner Domain</p>
            <p className="text-xs text-muted-foreground mb-2">Registers {import.meta.env.VITE_APP_DOMAIN || "example.com"} with Tesla. Public key must be hosted first.</p>
            {status.keypair_generated && !status.partner_registered && (
              <Button size="sm" onClick={handleRegister} disabled={loading || !status.credentials_configured} data-testid="button-register-partner">
                Register with Tesla
              </Button>
            )}
            {status.partner_registered && (
              <Button size="sm" variant="outline" onClick={handleRegister} disabled={loading || !status.credentials_configured} className="mt-1 text-xs" data-testid="button-reregister-partner">
                Re-register
              </Button>
            )}
          </div>
        </div>

        {/* Step 3: Authorize */}
        <div className="flex items-start gap-3">
          <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${status.user_authenticated ? 'bg-[hsl(var(--status-online))] text-white' : 'bg-muted text-muted-foreground'}`}>
            {status.user_authenticated ? <CheckCircle className="h-4 w-4" /> : '3'}
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">Authorize Your Tesla Account</p>
            <p className="text-xs text-muted-foreground mb-2">Sign in with Tesla to grant vehicle access.</p>
            {status.partner_registered && !status.user_authenticated && (
              <Button size="sm" onClick={handleAuth} disabled={loading || !status.credentials_configured} className="gap-1" data-testid="button-authorize-tesla">
                <ExternalLink className="h-3 w-3" /> Authorize with Tesla
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
