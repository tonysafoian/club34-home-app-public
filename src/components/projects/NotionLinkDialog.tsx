import { useState, useEffect } from 'react';
import { Search, Link2, Unlink, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useUpdateProject } from '@/hooks/useProjects';
import { searchNotionProjects } from '@/lib/api/notion';
import { useToast } from '@/hooks/use-toast';

interface NotionProject {
  id: string;
  title: string;
  source: string;
  url: string;
}

interface Props {
  projectId: string;
  notionPageId?: string | null;
}

export function NotionLinkDialog({ projectId, notionPageId }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NotionProject[]>([]);
  const [loading, setLoading] = useState(false);
  const updateProject = useUpdateProject();
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await searchNotionProjects(query);
        setResults(data as NotionProject[]);
      } catch (e) {
        console.error('Notion link fetch error:', e);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, open]);

  const handleLink = (notionProject: NotionProject) => {
    updateProject.mutate(
      { id: projectId, notion_page_id: notionProject.id },
      {
        onSuccess: () => {
          toast({ title: 'Linked to Notion', description: notionProject.title });
          setOpen(false);
        },
      }
    );
  };

  const handleUnlink = () => {
    updateProject.mutate(
      { id: projectId, notion_page_id: null },
      {
        onSuccess: () => {
          toast({ title: 'Unlinked from Notion' });
          setOpen(false);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={notionPageId ? 'text-primary' : 'text-muted-foreground'}
        >
          <Link2 className="h-4 w-4 mr-1.5" />
          <span className="hidden sm:inline">{notionPageId ? 'Linked' : 'Notion'}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to Notion Project</DialogTitle>
        </DialogHeader>

        {notionPageId && (
          <div className="flex items-center justify-between p-3 rounded-md bg-muted/50 border border-border">
            <span className="text-sm text-muted-foreground">Currently linked</span>
            <Button variant="outline" size="sm" onClick={handleUnlink}>
              <Unlink className="h-3.5 w-3.5 mr-1.5" />
              Unlink
            </Button>
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search Notion projects..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <ScrollArea className="max-h-[300px]">
          <div className="space-y-1">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && results.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {query ? 'No projects found' : 'Type to search projects'}
              </p>
            )}
            {!loading &&
              results.map((r) => (
                <button
                  key={r.id}
                  onClick={() => handleLink(r)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-md hover:bg-accent text-left transition-colors"
                >
                  <span className="text-sm font-medium truncate">{r.title || 'Untitled'}</span>
                  <Badge variant="secondary" className="ml-2 flex-shrink-0 text-xs">
                    {r.source}
                  </Badge>
                </button>
              ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
