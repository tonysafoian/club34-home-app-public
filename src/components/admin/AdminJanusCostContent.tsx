import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, DollarSign, Cpu, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UsageRow {
  key: string;
  cost_usd: number;
  tokens: number;
  calls: number;
}

interface LlmUsageResponse {
  window: { since: string; until: string };
  group_by: string;
  total: { cost_usd: number; tokens: number; calls: number };
  rows: UsageRow[];
  by_model: UsageRow[];
  by_channel: UsageRow[];
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact' }).format(n);

export function AdminJanusCostContent() {
  const queryClient = useQueryClient();

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ['admin-janus-cost'],
    queryFn: async () => (await apiClient.get('/api/admin/llm-usage?group_by=day')) as LlmUsageResponse,
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const total = data?.total ?? { cost_usd: 0, tokens: 0, calls: 0 };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Janus LLM usage — last 7 days</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['admin-janus-cost'] })}
          disabled={isRefetching}
          data-testid="button-refresh-janus-cost"
        >
          <RefreshCw className={cn('h-4 w-4 mr-1', isRefetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3">
        <StatTile icon={<DollarSign className="h-4 w-4" />} label="Cost" value={usd(total.cost_usd)} testId="stat-cost" />
        <StatTile icon={<Cpu className="h-4 w-4" />} label="Tokens" value={compact(total.tokens)} testId="stat-tokens" />
        <StatTile icon={<MessageSquare className="h-4 w-4" />} label="Calls" value={compact(total.calls)} testId="stat-calls" />
      </div>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BreakdownCard title="By Model" rows={data?.by_model ?? []} />
        <BreakdownCard title="By Channel" rows={data?.by_channel ?? []} />
      </div>

      {/* Daily trend */}
      {data && data.rows.length > 0 && (
        <Card className="p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Daily</p>
          <div className="space-y-1">
            {data.rows.map((r) => (
              <div key={r.key} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{r.key}</span>
                <span className="font-mono">{usd(r.cost_usd)} · {compact(r.calls)} calls</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function StatTile({ icon, label, value, testId }: { icon: React.ReactNode; label: string; value: string; testId: string }) {
  return (
    <Card className="p-3 flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
        {icon}
        {label}
      </div>
      <span className="text-lg font-semibold">{value}</span>
    </Card>
  );
}

function BreakdownCard({ title, rows }: { title: string; rows: UsageRow[] }) {
  return (
    <Card className="p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">{title}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No usage in this window.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-xs gap-2">
              <span className="truncate text-foreground/90" title={r.key}>{r.key || '—'}</span>
              <span className="font-mono shrink-0 text-muted-foreground">{usd(r.cost_usd)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
