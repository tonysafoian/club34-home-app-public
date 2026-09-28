import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getLogbook, HALogbookEntry } from '@/lib/api/homeAssistant';
import { formatDistanceToNow } from 'date-fns';

export function HALogbookCard({ hours = 6 }: { hours?: number }) {
  const [entries, setEntries] = useState<HALogbookEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLogbook(hours).then(data => {
      setEntries(Array.isArray(data) ? data.slice(0, 40) : []);
    }).catch(() => setEntries([])).finally(() => setLoading(false));
  }, [hours]);

  return (
    <Card className="md:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="h-5 w-5 text-muted-foreground" />
          Activity Log (last {hours}h)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No recent activity</p>
        ) : (
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {[...entries].reverse().map((entry, i) => (
              <div key={i} className="flex items-start gap-3 text-sm">
                <span className="text-xs text-muted-foreground mt-0.5 whitespace-nowrap flex-shrink-0">
                  {formatDistanceToNow(new Date(entry.when), { addSuffix: true })}
                </span>
                <span className="text-foreground">
                  <span className="font-medium">{entry.name}</span>{' '}
                  <span className="text-muted-foreground">{entry.message}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
