import { useState } from 'react';
import { useNotionDatabases, useAddSyncConfig } from '@/hooks/useNotion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Database, Plus, RefreshCw } from 'lucide-react';

interface NotionRichText {
  plain_text: string;
}

interface NotionDatabase {
  id: string;
  title?: NotionRichText[];
}

export function NotionDatabasePicker() {
  const { data: databases, isLoading, refetch } = useNotionDatabases();
  const dbList = (databases ?? []) as NotionDatabase[];
  const addSync = useAddSyncConfig();
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [syncDirection, setSyncDirection] = useState<'read' | 'write' | 'both'>('both');

  const handleConnect = () => {
    if (!selectedDb) return;
    const db = dbList.find((d) => d.id === selectedDb);
    const name = db ? extractDbTitle(db) : 'Unknown';
    addSync.mutate({ notionDatabaseId: selectedDb, databaseName: name, syncDirection });
    setSelectedDb('');
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Database className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">Connect a Notion Database</CardTitle>
              <CardDescription className="text-xs">
                Link a Notion database for two-way sync
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : dbList.length > 0 ? (
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium">Database</label>
              <Select value={selectedDb} onValueChange={setSelectedDb}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a Notion database" />
                </SelectTrigger>
                <SelectContent>
                  {dbList.map((db) => (
                    <SelectItem key={db.id} value={db.id}>
                      {extractDbTitle(db)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Sync Direction</label>
              <Select value={syncDirection} onValueChange={(v) => setSyncDirection(v as 'read' | 'write' | 'both')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="both">Two-way Sync</SelectItem>
                  <SelectItem value="read">Read Only</SelectItem>
                  <SelectItem value="write">Write Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleConnect}
              disabled={!selectedDb || addSync.isPending}
              className="w-full"
            >
              {addSync.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Connect Database
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No databases found. Make sure your Notion integration has access to at least one database.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function extractDbTitle(db: NotionDatabase): string {
  if (db.title && db.title.length > 0) {
    return db.title.map((t: NotionRichText) => t.plain_text).join('');
  }
  return 'Untitled Database';
}
