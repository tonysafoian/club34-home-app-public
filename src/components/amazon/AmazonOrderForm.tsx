import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mic, MicOff, Send, ShoppingCart, Loader2 } from 'lucide-react';
import { useVoiceInput } from '@/hooks/useVoiceInput';
import { useAmazonOrders } from '@/hooks/useAmazonOrders';

export default function AmazonOrderForm() {
  const [query, setQuery] = useState('');
  const [autoOrder, setAutoOrder] = useState(false);
  const { submitOrder, submitting } = useAmazonOrders();

  const { isListening, isSupported, toggleListening } = useVoiceInput({
    onResult: (transcript) => {
      setQuery((prev) => (prev ? `${prev} ${transcript}` : transcript));
    },
  });

  const handleSubmit = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const result = await submitOrder(trimmed, autoOrder);
    if (result) {
      setQuery('');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <ShoppingCart className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle>Find &amp; Order on Amazon</CardTitle>
            <CardDescription>
              Describe what you're looking for — type or use your voice
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Search input with voice */}
        <div className="space-y-2">
          <Label htmlFor="amazon-query">What are you looking for?</Label>
          <div className="relative">
            <Textarea
              id="amazon-query"
              placeholder="e.g. &quot;A 12-pack of AA batteries, best rated under $15&quot;"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-[100px] pr-14 resize-none"
              maxLength={500}
            />
            {isSupported && (
              <Button
                type="button"
                variant={isListening ? 'default' : 'ghost'}
                size="icon"
                className="absolute right-2 bottom-2"
                onClick={toggleListening}
                aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
              >
                {isListening ? (
                  <Mic className="h-4 w-4 animate-pulse" />
                ) : (
                  <MicOff className="h-4 w-4 text-muted-foreground" />
                )}
              </Button>
            )}
          </div>
          {isListening && (
            <p className="text-xs text-primary animate-pulse">Listening… speak now</p>
          )}
          <p className="text-xs text-muted-foreground">
            {query.length}/500 characters
          </p>
        </div>

        {/* Auto-order toggle */}
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="auto-order" className="text-sm font-medium">
              Auto-order
            </Label>
            <p className="text-xs text-muted-foreground">
              {autoOrder
                ? 'The system will complete the purchase automatically'
                : 'You\'ll review the cart before the order is placed'}
            </p>
          </div>
          <Switch
            id="auto-order"
            checked={autoOrder}
            onCheckedChange={setAutoOrder}
          />
        </div>

        {/* Submit */}
        <Button
          className="w-full"
          onClick={handleSubmit}
          disabled={!query.trim() || submitting}
        >
          {submitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Submitting…
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" />
              {autoOrder ? 'Find & Order' : 'Find & Add to Cart'}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
