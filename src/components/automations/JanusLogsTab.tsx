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
import { MessageSquare, Loader2, Eye, RefreshCw, Wrench, User, Image, FileText, FlaskConical } from 'lucide-react';
import { format } from 'date-fns';
import ReactMarkdown from 'react-markdown';

interface ToolCall {
  name: string;
  args?: unknown;
  result?: string;
}

interface JanusChatLog {
  id: string;
  user_id: string;
  user_display_name: string | null;
  user_role: string;
  user_message: string;
  assistant_response: string | null;
  tool_calls: ToolCall[];
  channel: string;
  media_type: string | null;
  created_at: string;
}

export function JanusLogsTab() {
  const [logs, setLogs] = useState<JanusChatLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<JanusChatLog | null>(null);

  useEffect(() => {
    fetchLogs();
  }, []);

  async function fetchLogs() {
    setLoading(true);
    const { data } = await apiClient.dbQuery<JanusChatLog[]>({
      table: 'janus_chat_logs',
      select: '*',
      order: { column: 'created_at', ascending: false },
      limit: 200,
    });
    if (data) setLogs(data);
    setLoading(false);
  }

  const channelBadge = (channel: string) => {
    const colors: Record<string, string> = {
      chat: 'bg-blue-500/10 text-blue-600',
      sms: 'bg-green-500/10 text-green-600',
      email: 'bg-purple-500/10 text-purple-600',
      whatsapp: 'bg-emerald-500/10 text-emerald-600',
    };
    return <Badge className={colors[channel] || 'bg-muted text-muted-foreground'}>{channel}</Badge>;
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
              <CardTitle>Janus Conversations ({logs.length})</CardTitle>
              <CardDescription>Every user request and Janus response, with tool calls</CardDescription>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={fetchLogs}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No conversations yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Media</TableHead>
                  <TableHead>Tools</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map(log => (
                  <TableRow key={log.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedLog(log)}>
                    <TableCell className="whitespace-nowrap text-sm">
                      {format(new Date(log.created_at), 'MMM d, h:mm a')}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const isSystemTest =
                          log.user_display_name?.includes('System Functional Test') ||
                          log.user_id?.startsWith('functional-test-');
                        return (
                          <div className="flex items-center gap-1.5">
                            {isSystemTest ? (
                              <FlaskConical className="h-3 w-3 text-violet-500" />
                            ) : (
                              <User className="h-3 w-3 text-muted-foreground" />
                            )}
                            <span className="text-sm">{log.user_display_name || 'Unknown'}</span>
                            {isSystemTest && (
                              <Badge variant="outline" className="text-[10px] px-1 border-violet-300 text-violet-600 dark:border-violet-700 dark:text-violet-400">System Test</Badge>
                            )}
                            <Badge variant="outline" className="text-[10px] px-1">{log.user_role}</Badge>
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="font-medium max-w-[220px] truncate text-sm">
                      {log.user_message}
                    </TableCell>
                    <TableCell>
                      {log.media_type === 'image' ? (
                        <div className="flex items-center gap-1" title="Contains image">
                          <Image className="h-3.5 w-3.5 text-primary" />
                          <span className="text-xs text-primary">image</span>
                        </div>
                      ) : log.media_type === 'pdf' ? (
                        <div className="flex items-center gap-1" title="Contains PDF">
                          <FileText className="h-3.5 w-3.5 text-primary" />
                          <span className="text-xs text-primary">pdf</span>
                        </div>
                      ) : log.media_type === 'audio' ? (
                        <span className="text-xs text-muted-foreground">🎤 audio</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {log.tool_calls && log.tool_calls.length > 0 ? (
                        <div className="flex items-center gap-1">
                          <Wrench className="h-3 w-3 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{log.tool_calls.length}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{channelBadge(log.channel)}</TableCell>
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
              <MessageSquare className="h-5 w-5" />
              Conversation Detail
            </DialogTitle>
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1 flex-wrap">
              <span>{selectedLog?.user_display_name || 'Unknown'}</span>
              <span>•</span>
              {selectedLog && channelBadge(selectedLog.channel)}
              {selectedLog?.media_type && (
                <>
                  <span>•</span>
                  <div className="flex items-center gap-1">
                    {selectedLog.media_type === 'pdf'
                      ? <FileText className="h-3 w-3" />
                      : <Image className="h-3 w-3" />}
                    <span>{selectedLog.media_type}</span>
                  </div>
                </>
              )}
              <span>•</span>
              <span>{selectedLog && format(new Date(selectedLog.created_at), 'MMM d, yyyy h:mm a')}</span>
            </div>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            {/* User message */}
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <User className="h-3 w-3" /> User Request
              </p>
              <p className="text-sm whitespace-pre-wrap">{selectedLog?.user_message}</p>
            </div>

            {/* Tool calls */}
            {selectedLog?.tool_calls && selectedLog.tool_calls.length > 0 && (
              <div className="rounded-lg border p-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                  <Wrench className="h-3 w-3" /> Tool Calls ({selectedLog.tool_calls.length})
                </p>
                <div className="space-y-2">
                  {selectedLog.tool_calls.map((tc: ToolCall, i: number) => (
                    <div key={i} className="text-xs bg-muted/50 rounded p-2">
                      <span className="font-mono font-semibold">{tc.name}</span>
                      {tc.args && (
                        <pre className="mt-1 text-muted-foreground overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(tc.args, null, 2).slice(0, 500)}
                        </pre>
                      )}
                      {tc.result && (
                        <div className="mt-1 text-muted-foreground border-t border-border pt-1">
                          <span className="font-medium">Result: </span>
                          {tc.result.slice(0, 300)}{tc.result.length > 300 ? '…' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Assistant response */}
            <div className="rounded-lg border p-4">
              <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> Janus Response
              </p>
              {selectedLog?.assistant_response ? (
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
                  <ReactMarkdown components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{selectedLog.assistant_response}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">No response recorded</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
