import { useSyncConfigs, useRemoveSyncConfig } from '@/hooks/useNotion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Database, Trash2, ArrowLeftRight, ArrowRight, ArrowLeft, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function NotionSyncedDatabases() {
  const { data: configs, isLoading } = useSyncConfigs();
  const removeSync = useRemoveSyncConfig();

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!configs || configs.length === 0) {
    return null;
  }

  const directionIcon = (dir: string) => {
    switch (dir) {
      case 'both': return <ArrowLeftRight className="h-3 w-3" />;
      case 'read': return <ArrowLeft className="h-3 w-3" />;
      case 'write': return <ArrowRight className="h-3 w-3" />;
      default: return null;
    }
  };

  const directionLabel = (dir: string) => {
    switch (dir) {
      case 'both': return 'Two-way';
      case 'read': return 'Read';
      case 'write': return 'Write';
      default: return dir;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Synced Databases</CardTitle>
        <CardDescription className="text-xs">
          Notion databases connected to Club 34
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {configs.map((config) => (
          <div
            key={config.id}
            className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border/50"
          >
            <div className="flex items-center gap-3 min-w-0">
              <Database className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {config.database_name || 'Untitled'}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="outline" className="text-[10px] gap-1 px-1.5 py-0">
                    {directionIcon(config.sync_direction)}
                    {directionLabel(config.sync_direction)}
                  </Badge>
                  {config.last_synced_at && (
                    <span className="text-[10px] text-muted-foreground">
                      Synced {formatDistanceToNow(new Date(config.last_synced_at), { addSuffix: true })}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
              onClick={() => removeSync.mutate(config.id)}
              disabled={removeSync.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
