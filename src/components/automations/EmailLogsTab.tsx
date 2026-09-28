import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Mail, Loader2, Eye, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';

interface EmailLog {
  id: string;
  email_type: string;
  subject: string;
  recipients: string[];
  html_body: string;
  text_body: string | null;
  status: string;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  sent_at: string;
}

export function EmailLogsTab() {
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<EmailLog | null>(null);

  useEffect(() => {
    fetchLogs();
  }, []);

  async function fetchLogs() {
    setLoading(true);
    const { data } = await apiClient.dbQuery<EmailLog[]>({
      table: 'email_logs',
      select: '*',
      order: { column: 'sent_at', ascending: false },
      limit: 100,
    });
    if (data) setLogs(data);
    setLoading(false);
  }

  const statusBadge = (status: string) => {
    if (status === 'sent') return <Badge className="bg-green-500/10 text-green-600">Sent</Badge>;
    if (status === 'error') return <Badge className="bg-red-500/10 text-red-600">Error</Badge>;
    return <Badge className="bg-amber-500/10 text-amber-600">{status}</Badge>;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Sent Emails ({logs.length})</CardTitle>
              <CardDescription>Click any row to preview the full email</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={fetchLogs}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No emails sent yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map(log => (
                  <TableRow key={log.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedLog(log)}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {format(new Date(log.sent_at), 'MMM d, yyyy h:mm a')}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{log.email_type}</Badge>
                    </TableCell>
                    <TableCell className="font-medium max-w-[300px] truncate">{log.subject}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {log.recipients.join(', ')}
                    </TableCell>
                    <TableCell>{statusBadge(log.status)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); setSelectedLog(log); }}>
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedLog} onOpenChange={() => setSelectedLog(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              {selectedLog?.subject}
            </DialogTitle>
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
              <span>To: {selectedLog?.recipients.join(', ')}</span>
              <span>•</span>
              <span>{selectedLog && format(new Date(selectedLog.sent_at), 'MMM d, yyyy h:mm a')}</span>
              <span>•</span>
              {selectedLog && statusBadge(selectedLog.status)}
            </div>
            {selectedLog?.error_message && (
              <p className="text-sm text-red-500 mt-2">Error: {selectedLog.error_message}</p>
            )}
          </DialogHeader>
          <div className="mt-4 border rounded-lg overflow-hidden">
            {selectedLog?.html_body ? (
              <iframe
                srcDoc={selectedLog.html_body}
                className="w-full min-h-[500px] border-0 bg-white"
                sandbox=""
                title="Email Preview"
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">No HTML content available.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
