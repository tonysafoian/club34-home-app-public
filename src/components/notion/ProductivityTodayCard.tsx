import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRight, RefreshCw, Plus, CheckCircle2 } from 'lucide-react';
import { useNotionActivityStats } from '@/hooks/useNotionActivity';

export function ProductivityTodayCard() {
  const navigate = useNavigate();
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const { data } = useNotionActivityStats(7);

  const todayData = data?.find((d) => d.date === todayStr);
  const updates = todayData?.janus_updates ?? 0;
  const newItems = todayData?.janus_new ?? 0;
  const completions = todayData?.janus_completions ?? 0;

  return (
    <Card
      className="glass cursor-pointer hover:ring-1 hover:ring-primary/30 transition-all active:scale-[0.98]"
      onClick={() => navigate(`/productivity/day/${todayStr}`)}
    >
      <CardContent className="p-4 flex items-center justify-between">
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-muted-foreground">Today</p>
          <p className="text-base font-semibold">{format(new Date(), 'EEEE, MMMM d')}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'hsl(var(--iaqualink))' }}>
              <RefreshCw className="h-3 w-3" /> {updates}
            </span>
            <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'hsl(var(--status-online))' }}>
              <Plus className="h-3 w-3" /> {newItems}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-accent">
              <CheckCircle2 className="h-3 w-3" /> {completions}
            </span>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}
