import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import AmazonOrderForm from '@/components/amazon/AmazonOrderForm';
import AmazonOrderHistory from '@/components/amazon/AmazonOrderHistory';

export default function AmazonOrder() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/automations')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold font-display">Amazon Order</h1>
            <p className="text-xs text-muted-foreground">Search, find & order from Amazon</p>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6 max-w-2xl">
        <AmazonOrderForm />
        <AmazonOrderHistory />
      </main>
    </div>
  );
}
