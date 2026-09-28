import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Activity, Globe, MessageSquare, Mail, HeartPulse, FlaskConical } from 'lucide-react';
import { ScrapeTab } from '@/components/automations/ScrapeTab';
import { SearchTab } from '@/components/automations/SearchTab';
import { EmailLogsTab } from '@/components/automations/EmailLogsTab';
import { JanusLogsTab } from '@/components/automations/JanusLogsTab';
import { JanusHealthTab } from '@/components/automations/JanusHealthTab';
import { SystemsTab } from '@/components/automations/SystemsTab';
import { JanusTestsTab } from '@/components/automations/JanusTestsTab';

function SectionHeader({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 mb-4">
      <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center mt-0.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function AdminAutomationsContent() {
  return (
    <Tabs defaultValue="systems" className="space-y-6">
      <TabsList className="grid w-full grid-cols-6">
        <TabsTrigger value="systems" className="gap-1 sm:gap-2">
          <Activity className="h-4 w-4" />
          <span className="hidden sm:inline">Systems</span>
        </TabsTrigger>
        <TabsTrigger value="health" className="gap-1 sm:gap-2">
          <HeartPulse className="h-4 w-4" />
          <span className="hidden sm:inline">Health</span>
        </TabsTrigger>
        <TabsTrigger value="janus-tests" className="gap-1 sm:gap-2">
          <FlaskConical className="h-4 w-4" />
          <span className="hidden sm:inline">Tests</span>
        </TabsTrigger>
        <TabsTrigger value="janus-logs" className="gap-1 sm:gap-2">
          <MessageSquare className="h-4 w-4" />
          <span className="hidden sm:inline">Janus</span>
        </TabsTrigger>
        <TabsTrigger value="email-logs" className="gap-1 sm:gap-2">
          <Mail className="h-4 w-4" />
          <span className="hidden sm:inline">Emails</span>
        </TabsTrigger>
        <TabsTrigger value="firecrawl" className="gap-1 sm:gap-2">
          <Globe className="h-4 w-4" />
          <span className="hidden sm:inline">Web</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="systems" className="space-y-4">
        <SectionHeader
          icon={Activity}
          title="Systems Overview"
          description="All scheduled jobs, live status from log tables, and self-healing alerts when anything needs attention."
        />
        <SystemsTab />
      </TabsContent>

      <TabsContent value="health" className="space-y-4">
        <SectionHeader icon={HeartPulse} title="Janus API Health" description="Real-time status of all 16 APIs used by Janus across channels, Google Workspace, Maps Platform, and third-party services." />
        <JanusHealthTab />
      </TabsContent>

      <TabsContent value="janus-tests" className="space-y-4">
        <SectionHeader
          icon={FlaskConical}
          title="Janus Functional Tests"
          description="Daily automated test suite — 8 real AI prompts across Notion, Calendar, Home Assistant, news, and role restrictions."
        />
        <JanusTestsTab />
      </TabsContent>

      <TabsContent value="janus-logs" className="space-y-4">
        <SectionHeader icon={MessageSquare} title="Janus Chat Logs" description="Every conversation any user has had with Janus, including tool calls and responses." />
        <JanusLogsTab />
      </TabsContent>

      <TabsContent value="email-logs" className="space-y-4">
        <SectionHeader icon={Mail} title="Email Logs" description="All automated emails sent by Janus and the system." />
        <EmailLogsTab />
      </TabsContent>

      <TabsContent value="firecrawl" className="space-y-6">
        <SectionHeader icon={Globe} title="Web Scraping & Search" description="Extract content from URLs or search the web — powered by Firecrawl." />
        <div className="grid gap-6 lg:grid-cols-2">
          <ScrapeTab />
          <SearchTab />
        </div>
      </TabsContent>
    </Tabs>
  );
}
