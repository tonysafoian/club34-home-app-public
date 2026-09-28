import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Database, FileText, Webhook, Plus, BarChart3 } from 'lucide-react';
import { NotionDatabasePicker } from '@/components/notion/NotionDatabasePicker';
import { NotionSyncedDatabases } from '@/components/notion/NotionSyncedDatabases';
import { NotionPageList } from '@/components/notion/NotionPageList';
import { NotionWebhookEvents } from '@/components/notion/NotionWebhookEvents';
import { NotionWebhookHealth } from '@/components/notion/NotionWebhookHealth';
import { NotionCreatePage } from '@/components/notion/NotionCreatePage';
import { NotionActivityChart } from '@/components/notion/NotionActivityChart';
import { NotionRecurringTasks } from '@/components/notion/NotionRecurringTasks';

export function AdminNotionContent() {
  return (
    <Tabs defaultValue="pages" className="space-y-6">
      <TabsList className="grid w-full grid-cols-5">
        <TabsTrigger value="pages" className="gap-1 sm:gap-2">
          <FileText className="h-4 w-4" />
          <span className="hidden sm:inline">Pages</span>
        </TabsTrigger>
        <TabsTrigger value="create" className="gap-1 sm:gap-2">
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">Create</span>
        </TabsTrigger>
        <TabsTrigger value="databases" className="gap-1 sm:gap-2">
          <Database className="h-4 w-4" />
          <span className="hidden sm:inline">DBs</span>
        </TabsTrigger>
        <TabsTrigger value="webhooks" className="gap-1 sm:gap-2">
          <Webhook className="h-4 w-4" />
          <span className="hidden sm:inline">Hooks</span>
        </TabsTrigger>
        <TabsTrigger value="activity" className="gap-1 sm:gap-2">
          <BarChart3 className="h-4 w-4" />
          <span className="hidden sm:inline">Activity</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="pages"><NotionPageList /></TabsContent>
      <TabsContent value="create"><NotionCreatePage /></TabsContent>
      <TabsContent value="databases" className="space-y-6">
        <NotionDatabasePicker />
        <NotionSyncedDatabases />
      </TabsContent>
      <TabsContent value="webhooks">
        <div className="space-y-4">
          <NotionWebhookHealth />
          <div className="rounded-lg border border-border/50 bg-muted/30 p-4">
            <h3 className="text-sm font-medium mb-1">Webhook Setup</h3>
            <p className="text-xs text-muted-foreground mb-2">
              To receive real-time updates from Notion, create a webhook subscription with this URL:
            </p>
            <code className="block text-xs bg-background/50 p-2 rounded border border-border/50 break-all select-all">
              {import.meta.env.VITE_API_URL}/api/notion/webhook
            </code>
          </div>
          <NotionWebhookEvents />
        </div>
      </TabsContent>
      <TabsContent value="activity">
        <div className="space-y-6">
          <NotionActivityChart />
          <NotionRecurringTasks />
        </div>
      </TabsContent>
    </Tabs>
  );
}
