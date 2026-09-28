import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, CheckCircle2, Lightbulb } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

interface SuggestionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Suggestion {
  id: string;
  status: string;
  created_at: string;
  content: string;
  admin_note: string | null;
}

function statusBadge(status: string) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-green-500/15 text-green-600 dark:text-green-400">
        Completed
      </span>
    );
  }
  if (status === 'acknowledged') {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-blue-500/15 text-blue-600 dark:text-blue-400">
        Acknowledged
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-warning/15 text-warning">
      Pending
    </span>
  );
}

export function SuggestionDialog({ open, onOpenChange }: SuggestionDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'submit' | 'history'>('submit');

  const MAX = 1000;
  const MIN = 20;

  const { data: mySuggestions, isLoading: suggestionsLoading } = useQuery({
    queryKey: ['my-suggestions', user?.userId],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Suggestion[]>({
        table: 'suggestions',
        select: '*',
        filters: [{ column: 'user_id', op: 'eq', value: user!.userId }],
        order: { column: 'created_at', ascending: false },
      });
      return data ?? [];
    },
    enabled: open && !!user,
  });

  function handleClose(val: boolean) {
    if (!val) {
      setTimeout(() => {
        setContent('');
        setSuccess(false);
        setPending(false);
        setActiveTab('submit');
      }, 300);
    }
    onOpenChange(val);
  }

  function handleViewSubmissions() {
    setSuccess(false);
    setActiveTab('history');
    queryClient.invalidateQueries({ queryKey: ['my-suggestions', user?.userId] });
  }

  async function handleSubmit() {
    if (!user || content.length < MIN || pending) return;

    setPending(true);
    try {
      const displayName = user.displayName || user.email;

      await apiClient.invokeFn('suggest-submit', {
        action: 'submit',
        content,
        user_display_name: displayName,
        user_email: user.email,
      });

      setSuccess(true);
    } catch (e) {
      toast({ title: 'Error', description: 'Failed to submit suggestion. Please try again.', variant: 'destructive' });
      console.error(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        {success ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Thanks for the suggestion!</h3>
              <p className="text-sm text-muted-foreground mt-1">
                It's been logged and you'll receive an email once it's reviewed.
              </p>
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="outline" size="sm" onClick={handleViewSubmissions}>
                View my submissions
              </Button>
              <Button size="sm" onClick={() => handleClose(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Lightbulb className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <DialogTitle>Make a suggestion</DialogTitle>
                  <DialogDescription className="mt-0.5">
                    Share an idea, feedback, or feature request.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'submit' | 'history')}>
              <TabsList className="w-full grid grid-cols-2">
                <TabsTrigger value="submit">Submit</TabsTrigger>
                <TabsTrigger value="history">
                  My Suggestions{mySuggestions?.length ? ` (${mySuggestions.length})` : ''}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="submit">
                <div className="space-y-3 mt-1">
                  <div className="relative">
                    <Textarea
                      value={content}
                      onChange={(e) => setContent(e.target.value.slice(0, MAX))}
                      placeholder="What's on your mind? Be as specific as you like..."
                      className="min-h-[140px] resize-none pr-3 pb-7"
                      autoFocus
                    />
                    <span className={cn(
                      'absolute bottom-2 right-3 text-xs',
                      content.length >= MAX ? 'text-destructive' : 'text-muted-foreground'
                    )}>
                      {content.length} / {MAX}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      {content.length < MIN && content.length > 0
                        ? `${MIN - content.length} more characters needed`
                        : content.length === 0
                        ? `At least ${MIN} characters required`
                        : ''}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => handleClose(false)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSubmit}
                        disabled={content.length < MIN || pending}
                      >
                        {pending ? (
                          <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Submitting…</>
                        ) : (
                          'Submit'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="history" className="max-h-[340px] overflow-y-auto mt-1">
                {suggestionsLoading ? (
                  <div className="space-y-3 py-2">
                    <Skeleton className="h-20 w-full rounded-md" />
                    <Skeleton className="h-20 w-full rounded-md" />
                  </div>
                ) : !mySuggestions || mySuggestions.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                    <Lightbulb className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      No suggestions yet — submit your first one!
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3 py-1">
                    {mySuggestions.map((s) => (
                      <div key={s.id} className="rounded-lg border bg-card p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          {statusBadge(s.status)}
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">
                            {format(new Date(s.created_at), 'MMM d, yyyy')}
                          </span>
                        </div>
                        <div className="bg-muted/40 rounded-md p-3 text-sm">
                          {s.content}
                        </div>
                        {s.admin_note && (
                          <div className="pl-3 border-l-2 border-muted">
                            <span className="text-xs font-medium text-muted-foreground">Admin note: </span>
                            <span className="text-xs italic text-muted-foreground">{s.admin_note}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
