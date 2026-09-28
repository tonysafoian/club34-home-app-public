import { useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useUserRole } from '@/hooks/useUserRole';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import {
  Users, Bot, FileText, Mail, Shield, Loader2, ArrowLeft, ShieldCheck,
  HeartPulse, Lightbulb, UserX, Home, Wrench, Car, UsersRound, HeartHandshake, Sparkles, AlertTriangle, Network,
  Activity, TrendingUp, Globe, Lock, Wifi, Plug, Trophy, DollarSign, Receipt,
} from 'lucide-react';
import { MobileChipNav, DesktopSidebar } from '@/components/shared/SectionNav';
import type { SectionGroup } from '@/components/shared/SectionNav';
import { AdminPromptsContent } from '@/components/admin/AdminPromptsContent';
import { AdminUsersContent } from '@/components/admin/AdminUsersContent';
import { VerkadaPeopleTracker } from '@/components/dashboard/systems/VerkadaPeopleTracker';
import { AdminAutomationsContent } from '@/components/admin/AdminAutomationsContent';
import { AdminNotionContent } from '@/components/admin/AdminNotionContent';
import { AdminEmailLogsContent } from '@/components/admin/AdminEmailLogsContent';
import { AdminJanusAccessContent } from '@/components/admin/AdminJanusAccessContent';
import { AdminSuggestionsContent } from '@/components/admin/AdminSuggestionsContent';
import { AdminOutsiderLogsContent } from '@/components/admin/AdminOutsiderLogsContent';
import { AdminHomeAssistantContent } from '@/components/admin/AdminHomeAssistantContent';
import { AdminHomeSystemsDevContent } from '@/components/admin/AdminHomeSystemsDevContent';
import { AdminTeslaActivityContent } from '@/components/admin/AdminTeslaActivityContent';
import { AdminGroupConfigsContent } from '@/components/admin/AdminGroupConfigsContent';
import { AdminHouseholdContent } from '@/components/admin/AdminHouseholdContent';
import { AdminUpdatesContent } from '@/components/admin/AdminUpdatesContent';
import { AdminSystemLogsContent } from '@/components/admin/AdminSystemLogsContent';
import { AdminFailedJobsContent } from '@/components/admin/AdminFailedJobsContent';
import { AdminActionItemsContent } from '@/components/admin/AdminActionItemsContent';
import { AdminJanusCostContent } from '@/components/admin/AdminJanusCostContent';
import { AdminJanusSkillsContent } from '@/components/admin/AdminJanusSkillsContent';
import { AdminNetworkContent } from '@/components/admin/AdminNetworkContent';
import { AdminWirelessContent } from '@/components/admin/AdminWirelessContent';
import { AdminApiContent } from '@/components/admin/AdminApiContent';

const ADMIN_GROUPS: SectionGroup[] = [
  {
    group: 'People & Access',
    items: [
      { id: 'users', label: 'Users', icon: Users },
      { id: 'household', label: 'Household', icon: HeartHandshake },
      { id: 'group-configs', label: 'Group Configs', icon: UsersRound },
      { id: 'people-tracker', label: 'People Tracker', icon: Users },
      { id: 'outsider-logs', label: 'Outsider Logs', icon: UserX },
    ],
  },
  {
    group: 'Janus & AI',
    items: [
      { id: 'janus-access', label: 'Janus Access', icon: Shield },
      { id: 'janus-skills', label: 'Skills', icon: Sparkles },
      { id: 'janus-cost', label: 'Janus Cost', icon: DollarSign },
      { id: 'prompts', label: 'Soul', icon: HeartPulse },
      { id: 'suggestions', label: 'Suggestions', icon: Lightbulb },
      { id: 'email-logs', label: 'Email Logs', icon: Mail },
    ],
  },
  {
    group: 'Home & Vehicles',
    items: [
      { id: 'home-assistant', label: 'Home Assistant', icon: Home },
      { id: 'home-systems-dev', label: 'Home Systems Dev', icon: Wrench },
      { id: 'tesla-activity', label: 'Tesla Activity', icon: Car },
    ],
  },
  {
    group: 'Household',
    items: [
      { id: 'vendors-expenses', label: 'Vendors & Expenses', icon: Receipt },
    ],
  },
  {
    group: 'Integrations & Content',
    items: [
      { id: 'notion', label: 'Notion', icon: FileText },
      { id: 'automations', label: 'Automations', icon: Bot },
      { id: 'api', label: 'API', icon: Plug },
      { id: 'action-items', label: 'Action Items', icon: AlertTriangle },
      { id: 'failed-jobs', label: 'Failed Jobs', icon: AlertTriangle },
      { id: 'updates', label: 'Updates', icon: Sparkles },
      { id: 'system-logs', label: 'System Logs', icon: FileText },
    ],
  },
  {
    group: 'Network',
    items: [
      { id: 'fw-overview', label: 'Overview', icon: Activity },
      { id: 'fw-devices', label: 'Devices', icon: Users },
      { id: 'fw-traffic', label: 'Traffic', icon: TrendingUp },
      { id: 'fw-top-sites', label: 'Top Sites', icon: Globe },
      { id: 'fw-security', label: 'Security', icon: Lock },
      { id: 'fw-interfaces', label: 'Interfaces', icon: Network },
      // Wireless (Ruckus) is one entry; its Access Points / Clients / SSIDs /
      // Diagnostics live as tabs inside AdminWirelessContent.
      { id: 'wl-overview', label: 'Wireless', icon: Wifi },
    ],
  },
];

const ALL_ITEMS = ADMIN_GROUPS.flatMap(g => g.items);

export default function Admin() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { isAdmin, loading } = useUserRole();
  const { user } = useAuth();
  const isMobile = useIsMobile();

  const activeSection = searchParams.get('section') || 'users';

  const { data: pendingCount } = useQuery({
    queryKey: ['suggestions-pending-count'],
    queryFn: async () => {
      const count = await apiClient.dbCount(
        'suggestions',
        [{ column: 'status', op: 'eq', value: 'pending' }],
      );
      return count;
    },
    enabled: isAdmin,
  });

  const { data: failedJobsCount } = useQuery({
    queryKey: ['failed-jobs-active-count'],
    queryFn: async () => {
      try {
        const count = await apiClient.dbCount(
          'failed_jobs',
          [{ column: 'status', op: 'in', value: ['pending', 'retrying'] }],
        );
        return count;
      } catch { return 0; }
    },
    enabled: isAdmin,
    staleTime: 60_000,
  });

  // Inject badge counts into nav items
  const groupsWithBadges: SectionGroup[] = ADMIN_GROUPS.map(g => ({
    ...g,
    items: g.items.map(item => {
      if (item.id === 'suggestions') return { ...item, badge: pendingCount ?? undefined };
      if (item.id === 'failed-jobs') return { ...item, badge: failedJobsCount ?? undefined };
      return item;
    }),
  }));

  useEffect(() => {
    if (!loading && !isAdmin) navigate('/');
  }, [isAdmin, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) return null;

  function setSection(id: string) {
    if (id === 'vendors-expenses') {
      navigate('/time/admin');
      return;
    }
    setSearchParams({ section: id });
  }

  const activeLabel = ALL_ITEMS.find(i => i.id === activeSection)?.label ?? 'Admin';

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')} className="shrink-0">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-semibold font-display leading-tight">Admin</h1>
              {!isMobile && <p className="text-xs text-muted-foreground truncate">{activeLabel}</p>}
            </div>
          </div>
        </div>
      </header>

      {/* Mobile chip nav */}
      {isMobile && (
        <MobileChipNav
          groups={groupsWithBadges}
          activeSection={activeSection}
          onSectionChange={setSection}
        />
      )}

      <div className="flex">
        {/* Desktop sidebar */}
        {!isMobile && (
          <DesktopSidebar
            groups={groupsWithBadges}
            activeSection={activeSection}
            onSectionChange={setSection}
          />
        )}

        {/* Content */}
        <main className="flex-1 min-w-0 container py-6">
          <ErrorBoundary name={`admin-${activeSection}`}>
            {activeSection === 'users' && <AdminUsersContent />}
            {activeSection === 'people-tracker' && <VerkadaPeopleTracker />}
            {activeSection === 'automations' && <AdminAutomationsContent />}
            {activeSection === 'api' && <AdminApiContent />}
            {activeSection === 'notion' && <AdminNotionContent />}
            {activeSection === 'email-logs' && <AdminEmailLogsContent />}
            {activeSection === 'janus-access' && <AdminJanusAccessContent />}
            {activeSection === 'janus-skills' && <AdminJanusSkillsContent />}
            {activeSection === 'prompts' && <AdminPromptsContent />}
            {activeSection === 'suggestions' && <AdminSuggestionsContent />}
            {activeSection === 'outsider-logs' && <AdminOutsiderLogsContent />}
            {activeSection === 'group-configs' && <AdminGroupConfigsContent />}
            {activeSection === 'home-assistant' && <AdminHomeAssistantContent />}
            {activeSection === 'home-systems-dev' && <AdminHomeSystemsDevContent />}
            {activeSection === 'tesla-activity' && <AdminTeslaActivityContent />}
            {activeSection === 'household' && <AdminHouseholdContent />}
            {activeSection === 'janus-cost' && <AdminJanusCostContent />}
            {activeSection === 'action-items' && <AdminActionItemsContent />}
            {activeSection === 'failed-jobs' && <AdminFailedJobsContent />}
            {activeSection === 'updates' && <AdminUpdatesContent />}
            {activeSection === 'system-logs' && <AdminSystemLogsContent />}
            {activeSection === 'fw-overview' && <AdminNetworkContent initialTab="overview" />}
            {activeSection === 'fw-devices' && <AdminNetworkContent initialTab="devices" />}
            {activeSection === 'fw-traffic' && <AdminNetworkContent initialTab="traffic" />}
            {activeSection === 'fw-top-sites' && <AdminNetworkContent initialTab="top-sites" />}
            {activeSection === 'fw-security' && <AdminNetworkContent initialTab="security" />}
            {activeSection === 'fw-interfaces' && <AdminNetworkContent initialTab="interfaces" />}
            {activeSection === 'firewall-interfaces' && <AdminNetworkContent initialTab="interfaces" />}
            {activeSection === 'wl-overview' && <AdminWirelessContent initialTab="overview" />}
            {activeSection === 'wl-aps' && <AdminWirelessContent initialTab="aps" />}
            {activeSection === 'wl-clients' && <AdminWirelessContent initialTab="clients" />}
            {activeSection === 'wl-wlans' && <AdminWirelessContent initialTab="wlans" />}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
