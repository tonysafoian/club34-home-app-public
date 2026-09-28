import { useState } from 'react';
import { firecrawlApi } from '@/lib/api/firecrawl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Globe, Loader2, CheckCircle2, AlertCircle, Search, FileText } from 'lucide-react';

export function ScrapeTab() {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof firecrawlApi.scrape>> | null>(null);

  const handleScrape = async () => {
    if (!url.trim()) return;
    setScraping(true);
    setResult(null);

    try {
      const response = await firecrawlApi.scrape(url.trim(), {
        formats: ['markdown', 'links'],
      });
      setResult(response);

      if (response.success) {
        toast({ title: 'Scrape complete', description: `Successfully scraped ${url}` });
      } else {
        toast({
          title: 'Scrape failed',
          description: response.error || 'Unknown error',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setScraping(false);
    }
  };

  const markdown = result?.data?.markdown ?? (result?.markdown as string | undefined);
  const links = result?.data?.links ?? (result?.links as string[] | undefined);
  const metadata = result?.data?.metadata ?? (result?.metadata as { title?: string } | undefined);

  return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Globe className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="font-display">Scrape Page</CardTitle>
              <CardDescription>
                Extract content from any URL as clean markdown
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="scrape-url">URL to scrape</Label>
            <Input
              id="scrape-url"
              type="url"
              placeholder="https://example.com/page"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <Button onClick={handleScrape} disabled={!url.trim() || scraping}>
            {scraping ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Scraping...
              </>
            ) : (
              <>
                <FileText className="mr-2 h-4 w-4" />
                Scrape
              </>
            )}
          </Button>

          {result && (
            <div className="space-y-4 pt-4 border-t border-border">
              <div className="flex items-center gap-2">
                <Badge variant={result.success !== false ? 'default' : 'destructive'} className="gap-1">
                  {result.success !== false ? (
                    <><CheckCircle2 className="w-3 h-3" /> Success</>
                  ) : (
                    <><AlertCircle className="w-3 h-3" /> Failed</>
                  )}
                </Badge>
                {metadata?.title && (
                  <span className="text-sm text-muted-foreground truncate">{metadata.title}</span>
                )}
              </div>

              {markdown && (
                <div className="space-y-2">
                  <Label>Extracted Content</Label>
                  <div className="rounded-lg border border-border bg-muted/50 p-4 max-h-80 overflow-auto">
                    <pre className="text-xs font-mono whitespace-pre-wrap text-foreground">
                      {markdown.slice(0, 5000)}
                      {markdown.length > 5000 && '\n\n... (truncated)'}
                    </pre>
                  </div>
                </div>
              )}

              {links && links.length > 0 && (
                <div className="space-y-2">
                  <Label>Links Found ({links.length})</Label>
                  <div className="rounded-lg border border-border bg-muted/50 p-4 max-h-40 overflow-auto">
                    <ul className="text-xs space-y-1">
                      {links.slice(0, 20).map((link: string, i: number) => (
                        <li key={i} className="truncate text-muted-foreground">
                          <a href={link} target="_blank" rel="noopener noreferrer" className="hover:text-primary">
                            {link}
                          </a>
                        </li>
                      ))}
                      {links.length > 20 && (
                        <li className="text-muted-foreground">... and {links.length - 20} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
  );
}
