import { Battery } from 'lucide-react';

export function BatteryBar({ level }: { level: number }) {
  const color = level > 50 ? 'bg-[hsl(var(--status-online))]' : level > 20 ? 'bg-[hsl(var(--status-warning))]' : 'bg-[hsl(var(--status-offline))]';
  return (
    <div className="flex items-center gap-2 w-full">
      <Battery className="h-5 w-5 text-muted-foreground shrink-0" />
      <div className="flex-1 h-3 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${level}%` }} />
      </div>
      <span className="text-sm font-medium tabular-nums w-10 text-right">{level}%</span>
    </div>
  );
}
