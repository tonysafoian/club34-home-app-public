import { useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { apiClient } from '@/lib/apiClient';
import { format, parseISO } from 'date-fns';
import { ArrowLeft, Sparkles, MapPin, User, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SuggestionDialog } from '@/components/suggestions/SuggestionDialog';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';

interface SystemUpdate {
  id: string;
  version: string;
  title: string;
  description: string;
  update_type: string;
  published_at: string;
  access_hint: string | null;
  suggested_by: string | null;
  created_at: string;
}

const TYPE_CONFIG: Record<string, { label: string; dotClass: string; badgeClass: string }> = {
  feature: {
    label: 'Feature',
    dotClass: 'bg-emerald-500',
    badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
  },
  improvement: {
    label: 'Improvement',
    dotClass: 'bg-blue-500',
    badgeClass: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  },
  fix: {
    label: 'Fix',
    dotClass: 'bg-amber-500',
    badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  },
};

function parseDescription(desc: string): string[] {
  return desc
    .split('\n')
    .map(l => l.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
}

export default function Updates() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [suggestionOpen, setSuggestionOpen] = useState(false);

  const { data: updates = [], isLoading } = useQuery({
    queryKey: ['system-updates'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<SystemUpdate[]>({
        table: 'system_updates',
        select: '*',
        filters: [{ column: 'published_at', op: 'lte', value: new Date().toISOString() }],
        order: { column: 'published_at', ascending: false },
        limit: 50,
      });
      return data ?? [];
    },
    enabled: !!user,
  });

  // Group by month
  const grouped = updates.reduce<Record<string, SystemUpdate[]>>((acc, u) => {
    const key = format(parseISO(u.published_at), 'MMMM yyyy').toUpperCase();
    (acc[key] ??= []).push(u);
    return acc;
  }, {});

  const latestVersion = updates[0]?.version;

  if (!user) return null;

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <ErrorBoundary name="updates">
      <div className="container max-w-2xl py-8 pb-24 md:pb-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">What's New</h1>
                {latestVersion && (
                  <Badge variant="outline" className="text-xs">{latestVersion}</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">Latest updates and improvements</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setSuggestionOpen(true)}>
            <Sparkles className="h-4 w-4 mr-2" />
            Suggest
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-10">
            {Object.entries(grouped).map(([month, items]) => (
              <div key={month}>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">{month}</h2>
                <div className="space-y-4">
                  {items.map((update) => {
                    const config = TYPE_CONFIG[update.update_type] || TYPE_CONFIG.feature;
                    const bullets = parseDescription(update.description);
                    return (
                      <div key={update.id} className="flex gap-4">
                        <div className="flex flex-col items-center">
                          <div className={`w-3 h-3 rounded-full ${config.dotClass} mt-1.5`} />
                          <div className="flex-1 w-px bg-border" />
                        </div>
                        <div className="pb-6 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge className={config.badgeClass}>{config.label}</Badge>
                            <span className="text-xs text-muted-foreground">{update.version}</span>
                          </div>
                          <h3 className="font-semibold mb-1">{update.title}</h3>
                          <ul className="text-sm text-muted-foreground space-y-1">
                            {bullets.map((b, i) => (
                              <li key={i} className="flex gap-2">
                                <span className="text-muted-foreground/50">•</span>
                                <span>{b}</span>
                              </li>
                            ))}
                          </ul>
                          {update.suggested_by && (
                            <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                              <User className="h-3 w-3" /> Suggested by {update.suggested_by}
                            </p>
                          )}
                          {update.access_hint && (
                            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                              <MapPin className="h-3 w-3" /> {update.access_hint}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </ErrorBoundary>

      <SuggestionDialog open={suggestionOpen} onOpenChange={setSuggestionOpen} />
      <MobileBottomNav />
    </div>
  );
}
