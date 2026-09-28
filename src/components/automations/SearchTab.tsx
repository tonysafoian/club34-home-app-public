import { useState } from 'react';
import { firecrawlApi } from '@/lib/api/firecrawl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Search, Loader2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';

interface SearchResultItem {
  title?: string;
  url?: string;
  description?: string;
}

export function SearchTab() {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Awaited<ReturnType<typeof firecrawlApi.search>> | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setResults(null);

    try {
      const response = await firecrawlApi.search(query.trim(), { limit: 10 });
      setResults(response);

      if (response.success) {
        toast({ title: 'Search complete', description: `Found results for "${query}"` });
      } else {
        toast({
          title: 'Search failed',
          description: response.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const searchData: SearchResultItem[] = Array.isArray(results?.data) ? results.data : [];

  return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
              <Search className="w-5 h-5 text-accent" />
            </div>
            <div>
              <CardTitle className="font-display">Web Search</CardTitle>
              <CardDescription>
                Search the web and optionally scrape results
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="search-query">Search query</Label>
            <Input
              id="search-query"
              placeholder="Beverly Hills luxury estates for sale"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
          </div>

          <Button onClick={handleSearch} disabled={!query.trim() || searching}>
            {searching ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Searching...
              </>
            ) : (
              <>
                <Search className="mr-2 h-4 w-4" />
                Search
              </>
            )}
          </Button>

          {results && (
            <div className="space-y-3 pt-4 border-t border-border">
              <div className="flex items-center gap-2">
                <Badge variant={results.success !== false ? 'default' : 'destructive'} className="gap-1">
                  {results.success !== false ? (
                    <><CheckCircle2 className="w-3 h-3" /> {searchData.length} results</>
                  ) : (
                    <><AlertCircle className="w-3 h-3" /> Failed</>
                  )}
                </Badge>
              </div>

              {searchData.length > 0 && (
                <div className="space-y-3">
                  {searchData.map((item: SearchResultItem, i: number) => (
                    <div
                      key={i}
                      className="rounded-lg border border-border bg-muted/50 p-4 space-y-1"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="text-sm font-medium text-foreground line-clamp-1">
                          {item.title || 'Untitled'}
                        </h4>
                        {item.url && (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-muted-foreground hover:text-primary"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </div>
                      {item.url && (
                        <p className="text-xs text-muted-foreground truncate">{item.url}</p>
                      )}
                      {item.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
  );
}
