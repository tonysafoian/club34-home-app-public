import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Mic, MicOff, Search, Apple, Loader2 } from 'lucide-react';
import { useVoiceInput } from '@/hooks/useVoiceInput';

interface GroceryOrderFormProps {
  onSearch: (query: string) => void;
  searching: boolean;
}

export default function GroceryOrderForm({ onSearch, searching }: GroceryOrderFormProps) {
  const [query, setQuery] = useState('');

  const { isListening, isSupported, toggleListening } = useVoiceInput({
    onResult: (transcript) => {
      setQuery((prev) => (prev ? `${prev} ${transcript}` : transcript));
    },
  });

  const handleSubmit = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    onSearch(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-500/10">
            <Apple className="h-5 w-5 text-green-500" />
          </div>
          <div>
            <CardTitle data-testid="text-grocery-title">Search Groceries on Amazon Fresh</CardTitle>
            <CardDescription>
              Type what you need and we'll browse Amazon Fresh to find it
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="grocery-query">What do you need?</Label>
          <div className="relative">
            <Textarea
              id="grocery-query"
              data-testid="input-grocery-query"
              placeholder='e.g. "organic whole milk, sourdough bread, avocados, cage-free eggs"'
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-[100px] pr-14 resize-none"
              maxLength={500}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            {isSupported && (
              <Button
                type="button"
                variant={isListening ? 'default' : 'ghost'}
                size="icon"
                className="absolute right-2 bottom-2"
                onClick={toggleListening}
                aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
                data-testid="button-voice-input"
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

        <Button
          className="w-full"
          onClick={handleSubmit}
          disabled={!query.trim() || searching}
          data-testid="button-search-groceries"
        >
          {searching ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Browsing Amazon Fresh…
            </>
          ) : (
            <>
              <Search className="mr-2 h-4 w-4" />
              Search Amazon Fresh
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
