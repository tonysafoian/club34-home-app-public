import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { format } from 'date-fns';
import { Shield, Phone, MessageSquare, Clock, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

interface OutsiderLogRow {
  user_id: string;
  user_message: string;
  assistant_response: string | null;
  created_at: string;
  channel: string;
}

interface OutsiderGroup {
  phone: string;
  messageCount: number;
  firstSeen: string;
  lastSeen: string;
  lastMessage: string;
  lastResponse: string | null;
}

export function AdminOutsiderLogsContent() {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['outsider-logs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<OutsiderLogRow[]>({
        table: 'janus_chat_logs',
        select: 'user_id, user_message, assistant_response, created_at, channel',
        filters: [
          { column: 'channel', op: 'eq', value: 'whatsapp' },
          { column: 'user_role', op: 'eq', value: 'outsider' },
        ],
        order: { column: 'created_at', ascending: false },
        limit: 500,
      });
      return data || [];
    },
  });

  // Group by phone number
  const grouped: OutsiderGroup[] = (() => {
    if (!logs) return [];
    const map = new Map<string, OutsiderGroup>();
    for (const row of logs) {
      const phone = row.user_id;
      if (!map.has(phone)) {
        map.set(phone, {
          phone,
          messageCount: 0,
          firstSeen: row.created_at,
          lastSeen: row.created_at,
          lastMessage: row.user_message,
          lastResponse: row.assistant_response,
        });
      }
      const entry = map.get(phone)!;
      entry.messageCount++;
      if (row.created_at > entry.lastSeen) {
        entry.lastSeen = row.created_at;
        entry.lastMessage = row.user_message;
        entry.lastResponse = row.assistant_response;
      }
      if (row.created_at < entry.firstSeen) {
        entry.firstSeen = row.created_at;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  })();

  const totalMessages = logs?.length ?? 0;
  const uniqueOutsiders = grouped.length;
  const abusers = grouped.filter(g => g.messageCount >= 3).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold font-display">Outsider Logs</h2>
        <p className="text-sm text-muted-foreground mt-1">
          WhatsApp interactions from unrecognized numbers not in the family roster
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <Phone className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{uniqueOutsiders}</p>
                <p className="text-xs text-muted-foreground">Unique outsiders</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <MessageSquare className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-2xl font-bold">{totalMessages}</p>
                <p className="text-xs text-muted-foreground">Total messages</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-warning" />
              <div>
                <p className="text-2xl font-bold text-warning">{abusers}</p>
                <p className="text-xs text-muted-foreground">Abuse alerts sent</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Outsider Activity</CardTitle>
          <CardDescription>Numbers with 3+ messages received an automatic abuse alert email</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : grouped.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
              <Shield className="h-10 w-10 opacity-40" />
              <p className="text-sm">No outsider activity recorded</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Phone</TableHead>
                  <TableHead className="text-center">Messages</TableHead>
                  <TableHead>Last Message</TableHead>
                  <TableHead>Last Response</TableHead>
                  <TableHead>Last Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grouped.map((g) => (
                  <TableRow key={g.phone}>
                    <TableCell className="font-mono text-sm">
                      <div className="flex items-center gap-2">
                        +{g.phone}
                        {g.messageCount >= 3 && (
                          <Badge variant="destructive" className="text-xs">
                            Alert sent
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <span className={g.messageCount >= 3 ? 'text-destructive font-semibold' : ''}>
                        {g.messageCount}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <p className="text-sm truncate text-muted-foreground" title={g.lastMessage}>
                        {g.lastMessage}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <p className="text-sm truncate text-muted-foreground" title={g.lastResponse || ''}>
                        {g.lastResponse || '—'}
                      </p>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {format(new Date(g.lastSeen), 'MMM d, h:mm a')}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
