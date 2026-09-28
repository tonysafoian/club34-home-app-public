import { useState } from 'react';
import { useSyncConfigs, useCreateNotionPage } from '@/hooks/useNotion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus } from 'lucide-react';

export function NotionCreatePage() {
  const { data: configs } = useSyncConfigs();
  const writableConfigs = configs?.filter(c => c.sync_direction !== 'read') ?? [];
  const createPage = useCreateNotionPage();

  const [selectedConfig, setSelectedConfig] = useState<string>('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  // Auto-select first config
  if (!selectedConfig && writableConfigs.length > 0) {
    setSelectedConfig(writableConfigs[0].id);
  }

  const activeConfig = writableConfigs.find(c => c.id === selectedConfig);

  const handleCreate = () => {
    if (!activeConfig || !title.trim()) return;

    const properties: Record<string, unknown> = {
      // Notion databases typically have a "Name" or "Title" property
      // We'll try the most common property name patterns
      Name: {
        title: [{ text: { content: title.trim() } }],
      },
    };

    const children = content.trim()
      ? [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ text: { content: content.trim() } }],
            },
          },
        ]
      : undefined;

    createPage.mutate({
      databaseId: activeConfig.notion_database_id,
      properties,
      content: children,
    });

    setTitle('');
    setContent('');
  };

  if (writableConfigs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No synced databases with write access. Connect a database with "Write" or "Two-way" sync first.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create Notion Page</CardTitle>
        <CardDescription className="text-xs">
          Add a new page to a synced Notion database
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {writableConfigs.length > 1 && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Database</label>
            <Select value={selectedConfig} onValueChange={setSelectedConfig}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {writableConfigs.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.database_name || 'Untitled'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">Title</label>
          <Input
            placeholder="Page title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Content (optional)</label>
          <Textarea
            placeholder="Page content…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
          />
        </div>

        <Button
          onClick={handleCreate}
          disabled={!title.trim() || createPage.isPending}
          className="w-full"
        >
          {createPage.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Create Page
        </Button>
      </CardContent>
    </Card>
  );
}
