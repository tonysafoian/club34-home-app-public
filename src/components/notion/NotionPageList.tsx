import { useState } from 'react';
import { useNotionDatabasePages, useSyncConfigs, extractPageTitle, extractPropertyValue } from '@/hooks/useNotion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Loader2, FileText } from 'lucide-react';

type NotionPageProperties = Parameters<typeof extractPageTitle>[0];

interface NotionPage {
  id: string;
  url?: string;
  properties?: NotionPageProperties;
}

interface SyncConfig {
  id: string;
  sync_direction: string;
  notion_database_id: string;
  database_name?: string;
}

export function NotionPageList() {
  const { data: configs } = useSyncConfigs();
  const configList = (configs ?? []) as SyncConfig[];
  const readableConfigs = configList.filter(c => c.sync_direction !== 'write');
  const [selectedConfig, setSelectedConfig] = useState<string>('');

  const activeConfig = readableConfigs.find(c => c.id === selectedConfig);
  const { data: pages, isLoading } = useNotionDatabasePages(
    activeConfig?.notion_database_id ?? null
  );
  const pageList = (pages ?? []) as NotionPage[];

  // Auto-select first config
  if (!selectedConfig && readableConfigs.length > 0) {
    setSelectedConfig(readableConfigs[0].id);
  }

  if (readableConfigs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No synced databases with read access. Connect a database first.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Notion Pages</CardTitle>
          {readableConfigs.length > 1 && (
            <Select value={selectedConfig} onValueChange={setSelectedConfig}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {readableConfigs.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.database_name || 'Untitled'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : pageList.length > 0 ? (
          <div className="space-y-2">
            {pageList.map((page) => (
              <NotionPageItem key={page.id} page={page} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            No pages found in this database.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function NotionPageItem({ page }: { page: NotionPage }) {
  const title = extractPageTitle(page.properties ?? {});
  const properties = page.properties || {};

  // Get a few preview properties (skip the title one)
  const previewProps = Object.entries(properties)
    .filter(([, prop]) => prop.type !== 'title')
    .slice(0, 3)
    .map(([key, prop]) => ({
      name: key,
      value: extractPropertyValue(prop),
      type: prop.type,
    }))
    .filter(p => p.value);

  return (
    <div className="flex items-start justify-between p-3 rounded-lg bg-muted/30 border border-border/30 hover:bg-muted/50 transition-colors">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <FileText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{title}</p>
          {previewProps.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {previewProps.map((prop) => (
                <Badge key={prop.name} variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                  {prop.name}: {prop.value}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      {page.url && (
        <a
          href={page.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-primary transition-colors shrink-0 ml-2"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </div>
  );
}
