/**
 * AdminBallContent — Host view for Club34 Ball
 *
 * Surfaces:
 *   - Upcoming games list with RSVP counts
 *   - Selected game detail: confirmed / declined / maybe / no-response
 *   - Actions: send invite blast, force ON/OFF, sync to GoAccess, mark attendance
 *   - Roster summary (count of active players)
 */

import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

// All /api/ball/admin/* endpoints are guarded by requireAuth, which
// accepts the auth_token JWT via Authorization: Bearer. The session
// cookie alone isn't reliable on prod (example.com is proxied to the
// Replit backend via _worker.js, and the cookie can age out), so we
// route every call through fetchWithAuth which attaches the localStorage
// JWT. Drop-in shape so existing call sites don't change.
const fetch = (url: string, init?: RequestInit) =>
  fetchWithAuth(url, init as RequestInit & { body?: string });
import ballLeagueLogo from '@/assets/ball/logo.jpg';
import { toast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Mail,
  Shield,
  Check,
  X,
  HelpCircle,
  Loader2,
  Users,
  AlertCircle,
  ChevronRight,
  Eye,
  MousePointerClick,
  Send,
  AlertTriangle,
  CalendarPlus,
  Trash2,
  Megaphone,
  Gavel,
  Copy,
  ExternalLink,
  ArrowUpDown,
  Search,
  ShirtIcon,
  Activity,
  ChevronDown,
  ChevronUp,
  UserPlus,
} from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AdminGame {
  id: string;
  gameDate: string;
  startTime: string;
  endTime: string;
  status: string;
  minPlayers: number;
  notes: string | null;
  inviteSentAt: string | null;
  decisionSentAt: string | null;
  reminderSentAt: string | null;
  counts: { in: number; out: number; maybe: number };
}

interface GameDetail {
  game: AdminGame;
  confirmed: Array<{
    rsvpId: string;
    playerId: string;
    name: string;
    email: string;
    isHost: boolean;
    showedUp: boolean | null;
    goaccessRegisteredAt: string | null;
    waiverSignedAt: string | null;
  }>;
  declined: Array<{ playerId: string; name: string; email: string; waiverSignedAt: string | null }>;
  maybe: Array<{ playerId: string; name: string; email: string; waiverSignedAt: string | null }>;
  noResponse: Array<{ id: string; name: string; email: string }>;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export default function AdminBallContent() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEngagementGameId, setSelectedEngagementGameId] = useState<string | null>(null);
  const rosterRef = useRef<HTMLDivElement>(null);

  const rosterQuery = useQuery<{ players: RosterPlayer[] }>({
    queryKey: ['ball-admin', 'players-roster'],
    queryFn: async () => {
      const r = await fetch('/api/ball/admin/players', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load roster');
      return r.json();
    },
    // Auto-refresh so stale RSVP/waiver state doesn't linger in the admin UI.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  const overview = useQuery<{
    games: AdminGame[];
    activePlayers: number;
    waiverVersion?: string;
    players?: Array<{
      id: string;
      name: string;
      email: string;
      isHost: boolean;
      waiver: { signed: boolean; version: string | null; signedAt: string | null };
    }>;
  }>({
    queryKey: ['ball-admin', 'overview'],
    queryFn: async () => {
      const r = await fetch('/api/ball/admin/overview', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load');
      return r.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  // Auto-select the next upcoming game
  const todayIso = new Date().toISOString().slice(0, 10);
  const effectiveId =
    selectedId ?? overview.data?.games.find(g => g.gameDate >= todayIso)?.id ?? null;

  const detail = useQuery<GameDetail>({
    queryKey: ['ball-admin', 'game', effectiveId],
    queryFn: async () => {
      const r = await fetch(`/api/ball/admin/game/${effectiveId}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load game');
      return r.json();
    },
    enabled: !!effectiveId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });

  const action = useMutation({
    mutationFn: async ({ kind, gameId, body }: { kind: string; gameId: string; body?: unknown }) => {
      const r = await fetch(`/api/ball/admin/game/${gameId}/${kind}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error('Action failed');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
    },
  });

  // NOTE: waiver revocation is intentionally NOT exposed in the
  // admin UI. The /api/ball/admin/players/:id/revoke-waiver endpoint
  // requires a true two-factor handshake (Computer Token header +
  // Google admin JWT) because revoking a legally-binding e-signature
  // is a high-impact action. The browser has no safe way to attach
  // the machine-level Computer Token, so the endpoint is operated
  // exclusively from the Computer Agent / curl. See EXTERNAL_API.md.

  const attendance = useMutation({
    mutationFn: async ({ gameId, playerId, showedUp }: { gameId: string; playerId: string; showedUp: boolean }) => {
      const r = await fetch(`/api/ball/admin/game/${gameId}/attendance`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, showedUp }),
      });
      if (!r.ok) throw new Error('Attendance update failed');
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ball-admin', 'game'] });
    },
  });

  if (overview.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-neutral-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <img src={ballLeagueLogo} alt="Club34 Ball" className="w-8 h-8 rounded-full object-cover" />
            Ball <Badge variant="secondary">Wednesday Pickup</Badge>
          </h2>
          <p className="text-muted-foreground text-sm mt-1" data-testid="text-ball-header-roster">
            {(() => {
              const rosterPlayers = rosterQuery.data?.players;
              const totalDads = rosterPlayers?.length ?? overview.data?.activePlayers ?? 0;
              const recipients = rosterPlayers
                ? rosterPlayers.filter(p => p.active && !p.isHost).length
                : null;
              return recipients !== null
                ? `${totalDads} dads on the roster (${recipients} recipients) · 6 player minimum to play`
                : `${totalDads} dads on the roster · 6 player minimum to play`;
            })()}
          </p>
        </div>
        <CreateGameDialog />
      </div>

      <div ref={rosterRef}>
        <DadsRosterSection
          games={overview.data?.games ?? []}
          selectedEngagementGameId={selectedEngagementGameId}
          onEngagementGameChange={setSelectedEngagementGameId}
        />
      </div>

      <BlastSummaryCard games={overview.data?.games ?? []} />

      <BackfillSection />

      <ActivitySection />

      <div className="grid md:grid-cols-3 gap-4">
        {/* Game list */}
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Games</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.data?.games.map(g => (
              <button
                key={g.id}
                onClick={() => setSelectedId(g.id)}
                className={`w-full text-left p-3 rounded-lg border transition-colors ${
                  effectiveId === g.id
                    ? 'bg-primary/10 border-primary/30'
                    : 'bg-card hover:bg-accent border-border'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold">{formatDate(g.gameDate)}</span>
                  <StatusBadge status={g.status} />
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Check className="w-3 h-3 text-emerald-500" /> {g.counts.in}
                  </span>
                  <span className="flex items-center gap-1">
                    <X className="w-3 h-3 text-neutral-500" /> {g.counts.out}
                  </span>
                  <span className="flex items-center gap-1">
                    <HelpCircle className="w-3 h-3 text-yellow-500" /> {g.counts.maybe}
                  </span>
                  <ChevronRight className="w-3 h-3 ml-auto" />
                </div>
              </button>
            ))}
            {(overview.data?.games.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground p-3">No games scheduled yet.</p>
            )}
          </CardContent>
        </Card>

        {/* Selected game detail */}
        <div className="md:col-span-2 space-y-4">
          {detail.data ? (
            <>
              {/* Actions */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {formatDate(detail.data.game.gameDate)} ·{' '}
                    <StatusBadge status={detail.data.game.status} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        action.mutate({ kind: 'send-invite', gameId: detail.data!.game.id })
                      }
                      disabled={action.isPending}
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      {detail.data.game.inviteSentAt ? 'Re-send invite' : 'Send invite blast'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        action.mutate({ kind: 'email-gate', gameId: detail.data!.game.id })
                      }
                      disabled={action.isPending}
                      data-testid="button-email-gate"
                    >
                      <Mail className="w-4 h-4 mr-2" />
                      Email gate list
                    </Button>
                    <Button
                      variant="outline"
                      className="text-emerald-500 hover:text-emerald-600"
                      onClick={() =>
                        action.mutate({
                          kind: 'force-status',
                          gameId: detail.data!.game.id,
                          body: { status: 'on' },
                        })
                      }
                      disabled={action.isPending}
                    >
                      Force ON
                    </Button>
                    <Button
                      variant="outline"
                      className="text-red-500 hover:text-red-600"
                      onClick={() =>
                        action.mutate({
                          kind: 'force-status',
                          gameId: detail.data!.game.id,
                          body: { status: 'off' },
                        })
                      }
                      disabled={action.isPending}
                    >
                      Force OFF
                    </Button>
                  </div>
                  {action.isSuccess && action.data && (
                    <div className="text-xs text-muted-foreground p-2 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-500">
                      {JSON.stringify(action.data)}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Confirmed */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Check className="w-4 h-4 text-emerald-500" />
                    Confirmed ({detail.data.confirmed.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1">
                    {detail.data.confirmed.map(p => (
                      <div
                        key={p.playerId}
                        className="flex items-center justify-between py-2 px-3 rounded hover:bg-accent"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{p.name}</span>
                          {p.isHost && (
                            <Badge variant="outline" className="text-xs">
                              host
                            </Badge>
                          )}
                          {p.goaccessRegisteredAt && (
                            <Badge variant="secondary" className="text-xs">
                              <Shield className="w-3 h-3 mr-1" /> gate
                            </Badge>
                          )}
                          {p.waiverSignedAt ? (
                            <Badge
                              variant="secondary"
                              className="text-xs"
                              title={`Waiver signed ${new Date(p.waiverSignedAt).toLocaleDateString()}`}
                              data-testid={`badge-waiver-signed-${p.playerId}`}
                            >
                              <Gavel className="w-3 h-3 mr-1" /> waiver
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-xs border-yellow-500/40 text-yellow-500"
                              data-testid={`badge-waiver-missing-${p.playerId}`}
                            >
                              <AlertTriangle className="w-3 h-3 mr-1" /> no waiver
                            </Badge>
                          )}
                          {/* Waiver revocation is machine-only (Computer Token + admin JWT) — see comment above the mutation block. */}
                        </div>
                        {!p.isHost && detail.data!.game.status === 'done' && (
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant={p.showedUp === true ? 'default' : 'outline'}
                              onClick={() =>
                                attendance.mutate({
                                  gameId: detail.data!.game.id,
                                  playerId: p.playerId,
                                  showedUp: true,
                                })
                              }
                            >
                              <Check className="w-3 h-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant={p.showedUp === false ? 'default' : 'outline'}
                              onClick={() =>
                                attendance.mutate({
                                  gameId: detail.data!.game.id,
                                  playerId: p.playerId,
                                  showedUp: false,
                                })
                              }
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                    {detail.data.confirmed.length === 0 && (
                      <p className="text-sm text-muted-foreground py-2">Nobody confirmed yet.</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Declined + Maybe + No-response — collapsed-ish */}
              <div className="grid sm:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <X className="w-3 h-3 text-neutral-500" />
                      Out ({detail.data.declined.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-1 text-muted-foreground">
                    {detail.data.declined.map(p => (
                      <div key={p.playerId}>{p.name}</div>
                    ))}
                    {detail.data.declined.length === 0 && <div>—</div>}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertCircle className="w-3 h-3 text-yellow-500" />
                      No response ({detail.data.noResponse.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm space-y-1 text-muted-foreground max-h-48 overflow-auto">
                    {detail.data.noResponse.map(p => (
                      <div key={p.id}>{p.name}</div>
                    ))}
                    {detail.data.noResponse.length === 0 && <div>—</div>}
                  </CardContent>
                </Card>
              </div>

              {/* Manual per-game blast + decision email triggers */}
              <ManualSendSection
                game={detail.data.game}
                confirmed={detail.data.confirmed}
                activePlayers={overview.data?.activePlayers ?? 0}
              />

              {/* Email engagement — now in the unified Dads Roster above */}
              <div className="mt-4 flex items-center justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-view-engagement-in-roster"
                  onClick={() => {
                    setSelectedEngagementGameId(effectiveId);
                    setTimeout(() => {
                      rosterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 50);
                  }}
                >
                  <Mail className="w-3.5 h-3.5 mr-1.5" />
                  View email engagement in roster
                </Button>
              </div>
            </>
          ) : (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                Select a game to see RSVP detail.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Add Dad Dialog ───────────────────────────────────────────────────────

const addDadSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().min(1, 'Email is required').email('Must be a valid email address'),
  phone: z.string().optional(),
  jerseySize: z.enum(['S', 'M', 'L', 'XL', 'XXL', 'XXXL', '']).optional(),
  notes: z.string().optional(),
  sendInvite: z.boolean(),
});
type AddDadFormValues = z.infer<typeof addDadSchema>;

class AddDadApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'AddDadApiError';
  }
}

function AddDadDialog({ existingEmails, onSuccess }: { existingEmails: Set<string>; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const form = useForm<AddDadFormValues>({
    resolver: zodResolver(addDadSchema),
    defaultValues: {
      name: '',
      email: '',
      phone: '',
      jerseySize: '',
      notes: '',
      sendInvite: true,
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: AddDadFormValues) => {
      const body: Record<string, unknown> = {
        name: values.name,
        email: values.email,
        sendInvite: values.sendInvite,
      };
      if (values.phone) body.phone = values.phone;
      if (values.jerseySize) body.jerseySize = values.jerseySize;
      if (values.notes) body.notes = values.notes;

      const r = await fetch('/api/ball/admin/players', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({ error: undefined })) as { error?: string };
        throw new AddDadApiError(data.error || `Request failed (HTTP ${r.status})`, r.status);
      }
      return r.json() as Promise<{ ok: boolean; player: { id: string; name: string }; inviteResult: { sent: number; failed: number; recipients: number } | null }>;
    },
    onSuccess: (data) => {
      const { inviteResult } = data;
      let description = `${data.player.name} has been added to the roster.`;
      if (inviteResult) {
        if (inviteResult.sent > 0) {
          const n = inviteResult.sent;
          description += ` Invite sent to ${n} ${n === 1 ? 'recipient' : 'recipients'}.`;
        } else if (inviteResult.recipients > 0) {
          description += ` Invite failed to send (${inviteResult.failed} failed).`;
        }
      }
      toast({ title: 'Dad added', description });
      queryClient.invalidateQueries({ queryKey: ['ball-admin', 'players-roster'] });
      queryClient.invalidateQueries({ queryKey: ['ball-admin', 'overview'] });
      setOpen(false);
      form.reset();
      onSuccess();
    },
    onError: (err: Error) => {
      if (err instanceof AddDadApiError && err.status === 409) {
        form.setError('email', { message: 'A dad with that email already exists' });
      } else {
        toast({ title: 'Add failed', description: err.message, variant: 'destructive' });
      }
    },
  });

  function onSubmit(values: AddDadFormValues) {
    // Pre-submit local duplicate check against already-loaded roster
    if (existingEmails.has(values.email.toLowerCase())) {
      form.setError('email', { message: 'A dad with that email already exists' });
      return;
    }
    mutation.mutate(values);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) form.reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="button-add-dad">
          <UserPlus className="w-3.5 h-3.5 mr-1.5" />
          Add Dad
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a Dad</DialogTitle>
          <DialogDescription>
            Add a new dad to the Ball roster. They'll receive an RSVP link and can sign the waiver from their personal page.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="John Smith" data-testid="input-dad-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email <span className="text-destructive">*</span></FormLabel>
                  <FormControl>
                    <Input {...field} type="email" placeholder="john@example.com" data-testid="input-dad-email" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="+1 (555) 000-0000" data-testid="input-dad-phone" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="jerseySize"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Jersey size <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-dad-jersey">
                        <SelectValue placeholder="Select a size…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="S">S</SelectItem>
                      <SelectItem value="M">M</SelectItem>
                      <SelectItem value="L">L</SelectItem>
                      <SelectItem value="XL">XL</SelectItem>
                      <SelectItem value="XXL">XXL</SelectItem>
                      <SelectItem value="XXXL">XXXL</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes <span className="text-muted-foreground text-xs">(optional)</span></FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Any notes about this dad…" rows={3} data-testid="textarea-dad-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="sendInvite"
              render={({ field }) => (
                <FormItem className="flex items-center gap-3 rounded-lg border border-border p-3 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="checkbox-send-invite"
                    />
                  </FormControl>
                  <div>
                    <FormLabel className="cursor-pointer">Send month invite immediately</FormLabel>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Emails the dad their personal RSVP link for all upcoming games this month.
                    </p>
                  </div>
                </FormItem>
              )}
            />
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setOpen(false); form.reset(); }}
                data-testid="button-cancel-add-dad"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-submit-add-dad">
                {mutation.isPending ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Adding…
                  </>
                ) : (
                  <>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                    Add Dad
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Dads Roster ─────────────────────────────────────────────────────────

interface RosterPlayer {
  id: string;
  name: string;
  email: string;
  token: string;
  isHost: boolean;
  active: boolean;
  jerseySize: string | null;
  waiverSigned: boolean;
  waiverVersion: string | null;
  waiverSignedAt: string | null;
  lastOpenedAt?: string | null;
  lastClickedAt?: string | null;
}

// Render an absolute timestamp ("May 16, 1:42 PM") with a relative
// tooltip — both forms are useful when scanning the roster: absolute
// for "did this happen during the blast window?", relative for "how
// stale is this?".
function formatRelativeTs(iso: string | null | undefined): { abs: string; rel: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const abs = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  let rel: string;
  if (mins < 1) rel = 'just now';
  else if (mins < 60) rel = `${mins} min ago`;
  else if (mins < 60 * 24) rel = `${Math.floor(mins / 60)} hr ago`;
  else rel = `${Math.floor(mins / (60 * 24))}d ago`;
  return { abs, rel };
}

type SortCol = 'name' | 'waiver' | 'jersey' | 'sent' | 'opened' | 'clicked' | 'rsvp';
type SortDir = 'asc' | 'desc';

// Map RSVP status to a numeric rank for sorting. Higher = stronger
// commitment. `null` (no RSVP) sorts lowest so asc surfaces dads who
// haven't responded yet.
function rsvpRank(status: 'in' | 'out' | 'maybe' | 'pending_reconfirm' | null | undefined): number {
  switch (status) {
    case 'in': return 4;
    case 'maybe': return 3;
    case 'pending_reconfirm': return 2;
    case 'out': return 1;
    default: return 0;
  }
}

// Convert an ISO timestamp (or null) into a number for sorting. `null`
// becomes 0 so asc surfaces dads with no signal yet ("show me who
// hasn't clicked").
function tsRank(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return isNaN(t) ? 0 : t;
}

function DadsRosterSection({
  games,
  selectedEngagementGameId,
  onEngagementGameChange,
}: {
  games: AdminGame[];
  selectedEngagementGameId: string | null;
  onEngagementGameChange: (gameId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [resendTarget, setResendTarget] = useState<{ playerIds: string[]; names: string[] } | null>(null);

  // Compute effective engagement game: explicit selection → next upcoming → most recent past
  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultEngagementGame = (() => {
    const upcoming = games.filter(g => g.gameDate >= todayIso).sort((a, b) => a.gameDate.localeCompare(b.gameDate))[0];
    if (upcoming) return upcoming;
    return games.slice().sort((a, b) => b.gameDate.localeCompare(a.gameDate))[0] ?? null;
  })();
  const effectiveEngagementGameId = selectedEngagementGameId ?? defaultEngagementGame?.id ?? null;

  const query = useQuery<{ players: RosterPlayer[] }>({
    queryKey: ['ball-admin', 'players-roster'],
    queryFn: async () => {
      const r = await fetch('/api/ball/admin/players', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load roster');
      return r.json();
    },
  });

  const engagementQuery = useQuery<EngagementPayload>({
    queryKey: ['ball-admin', 'engagement', effectiveEngagementGameId],
    queryFn: async () => {
      const r = await fetch(`/api/ball/admin/game/${effectiveEngagementGameId}/engagement`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load engagement');
      return r.json();
    },
    enabled: !!effectiveEngagementGameId,
  });

  // O(1) lookup map: playerId → EngagementRow
  const engagementMap = new Map<string, EngagementRow>(
    (engagementQuery.data?.rows ?? []).map(r => [r.playerId, r]),
  );

  // Engagement totals for the selected game
  const engTotals = { sent: 0, bounced: 0, opened: 0, clicked: 0, rsvpd: 0 };
  for (const row of engagementQuery.data?.rows ?? []) {
    if (row.rsvpStatus) engTotals.rsvpd++;
    for (const s of row.sends) {
      if (s.sentAt) engTotals.sent++;
      if (s.bouncedAt) engTotals.bounced++;
      if (s.openedAt) engTotals.opened++;
      if (s.firstClickedAt) engTotals.clicked++;
    }
  }
  const hasAppleMail = (engagementQuery.data?.rows ?? []).some(r =>
    r.sends.some(s => s.looksLikeAppleMail),
  );

  const resend = useMutation({
    mutationFn: async ({ playerIds, dryRun }: { playerIds: string[]; dryRun?: boolean }) => {
      const r = await fetch('/api/ball/admin/resend-month-invite', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds, dryRun: !!dryRun }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Resend failed (HTTP ${r.status})`);
      }
      return r.json() as Promise<{ ok: true; dryRun: boolean; sent: number; failed: number; recipients: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.dryRun ? 'Dry run complete' : 'Invite resent',
        description: data.dryRun
          ? `Would send to ${data.recipients} dad(s).`
          : `Sent ${data.sent} / failed ${data.failed} (of ${data.recipients})`,
      });
      setSelectedIds(new Set());
      setResendTarget(null);
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Resend failed', description: err.message, variant: 'destructive' });
    },
  });

  const players = query.data?.players ?? [];

  const totalDads = players.length;
  const signedWaivers = players.filter(p => p.waiverSigned).length;
  const missingJersey = players.filter(p => !p.jerseySize).length;

  const filtered = players.filter(p => {
    if (!search) return true;
    const q = search.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
  });

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortCol === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (sortCol === 'waiver') {
      cmp = (b.waiverSigned ? 1 : 0) - (a.waiverSigned ? 1 : 0);
    } else if (sortCol === 'jersey') {
      const jerseyOrder = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
      const ai = a.jerseySize ? jerseyOrder.indexOf(a.jerseySize) : 99;
      const bi = b.jerseySize ? jerseyOrder.indexOf(b.jerseySize) : 99;
      cmp = ai - bi;
    } else if (sortCol === 'sent' || sortCol === 'opened' || sortCol === 'clicked') {
      const sa = engagementMap.get(a.id)?.sends[0];
      const sb = engagementMap.get(b.id)?.sends[0];
      const field = sortCol === 'sent' ? 'sentAt'
        : sortCol === 'opened' ? 'openedAt'
        : 'firstClickedAt';
      cmp = tsRank(sa?.[field]) - tsRank(sb?.[field]);
    } else if (sortCol === 'rsvp') {
      cmp = rsvpRank(engagementMap.get(a.id)?.rsvpStatus)
        - rsvpRank(engagementMap.get(b.id)?.rsvpStatus);
    }
    const primary = sortDir === 'asc' ? cmp : -cmp;
    return primary !== 0 ? primary : a.name.localeCompare(b.name);
  });

  // Reset sort when the selected game changes — engagement values are
  // game-scoped, so a sort on "clicked for game A" makes no sense
  // after switching to game B.
  useEffect(() => {
    setSortCol('name');
    setSortDir('asc');
  }, [effectiveEngagementGameId]);

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  function rsvpUrlFor(player: RosterPlayer): string {
    return `https://example.com/ball/p/${player.token}`;
  }

  function copyText(text: string, playerId: string, label: string) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedId(playerId);
        toast({ title: 'Link copied', description: label });
        setTimeout(() => setCopiedId(null), 1500);
      } catch {
        toast({ title: 'Copy failed', description: 'Could not access clipboard. Try selecting the URL manually.', variant: 'destructive' });
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedId(playerId);
        toast({ title: 'Link copied', description: label });
        setTimeout(() => setCopiedId(null), 1500);
      }).catch(fallback);
    } else {
      fallback();
    }
  }

  function copyLink(player: RosterPlayer) {
    copyText(rsvpUrlFor(player), player.id, player.name);
  }

  return (
    <Card data-testid="card-dads-roster">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Users className="w-4 h-4 text-muted-foreground" />
          Dads Roster
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Game selector for engagement data */}
        {games.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">Engagement for:</span>
            <select
              value={effectiveEngagementGameId ?? ''}
              onChange={e => onEngagementGameChange(e.target.value)}
              className="text-xs rounded border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              data-testid="select-engagement-game"
            >
              {games.slice().sort((a, b) => a.gameDate.localeCompare(b.gameDate)).map(g => (
                <option key={g.id} value={g.id}>
                  {formatDate(g.gameDate)} — {g.status}
                </option>
              ))}
            </select>
            {engagementQuery.isLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
        )}

        {/* Combined summary — roster stats + engagement stats for selected game */}
        <div className="grid grid-cols-4 md:grid-cols-8 gap-3">
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-total-dads">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> Total
            </div>
            <div className="text-2xl font-bold mt-1">{query.isLoading ? '—' : totalDads}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-signed-waivers">
            <div className="text-xs text-emerald-500 flex items-center gap-1">
              <Gavel className="w-3.5 h-3.5" /> Waiver signed
            </div>
            <div className="text-2xl font-bold mt-1">{query.isLoading ? '—' : signedWaivers}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-2 md:col-span-1" data-testid="stat-missing-jersey">
            <div className={`text-xs flex items-center gap-1 ${missingJersey > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
              <ShirtIcon className="w-3.5 h-3.5" /> No jersey size
            </div>
            <div className="text-2xl font-bold mt-1">{query.isLoading ? '—' : missingJersey}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-engagement-sent">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Send className="w-3.5 h-3.5" /> Sent
            </div>
            <div className="text-2xl font-bold mt-1">{engagementQuery.isLoading ? '—' : engTotals.sent}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-engagement-bounced">
            <div className={`text-xs flex items-center gap-1 ${engTotals.bounced > 0 ? 'text-red-500' : 'text-muted-foreground'}`}>
              <AlertTriangle className="w-3.5 h-3.5" /> Bounced
            </div>
            <div className="text-2xl font-bold mt-1">{engagementQuery.isLoading ? '—' : engTotals.bounced}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-engagement-opened">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Eye className="w-3.5 h-3.5" /> Opened
            </div>
            <div className="text-2xl font-bold mt-1">{engagementQuery.isLoading ? '—' : engTotals.opened}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-engagement-clicked">
            <div className="text-xs text-emerald-500 flex items-center gap-1">
              <MousePointerClick className="w-3.5 h-3.5" /> Clicked
            </div>
            <div className="text-2xl font-bold mt-1">{engagementQuery.isLoading ? '—' : engTotals.clicked}</div>
          </div>
          <div className="rounded-lg border border-border bg-card p-3 col-span-1" data-testid="stat-engagement-rsvpd">
            <div className="text-xs text-emerald-500 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" /> RSVP'd
            </div>
            <div className="text-2xl font-bold mt-1">{engagementQuery.isLoading ? '—' : engTotals.rsvpd}</div>
          </div>
        </div>
        {hasAppleMail && (
          <p className="text-[10px] text-muted-foreground italic flex items-center gap-1">
            <AlertCircle className="w-3 h-3 shrink-0" />
            'Opened' is unreliable for Apple Mail users (Apple pre-fetches the pixel). 'Clicked' is the trustworthy signal.
          </p>
        )}

        {/* Search + bulk action bar */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Filter by name or email…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-roster-search"
            />
          </div>
          {selectedIds.size > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const picked = players.filter(p => selectedIds.has(p.id));
                setResendTarget({ playerIds: picked.map(p => p.id), names: picked.map(p => p.name) });
              }}
              data-testid="button-resend-selected"
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
              Resend to {selectedIds.size} selected
            </Button>
          )}
          <AddDadDialog
            existingEmails={new Set(players.map(p => p.email.toLowerCase()))}
            onSuccess={() => {}}
          />
        </div>

        {/* Table */}
        {query.isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-2 w-6">
                    <input
                      type="checkbox"
                      aria-label="Select all dads"
                      checked={sorted.length > 0 && sorted.every(p => selectedIds.has(p.id))}
                      onChange={e => {
                        if (e.target.checked) {
                          setSelectedIds(new Set(sorted.map(p => p.id)));
                        } else {
                          setSelectedIds(new Set());
                        }
                      }}
                      className="rounded border-border accent-primary"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th className="py-2 pr-4">
                    <button
                      onClick={() => handleSort('name')}
                      className="flex items-center gap-1 hover:text-foreground transition-colors"
                      data-testid="th-sort-name"
                    >
                      Name <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-4 hidden sm:table-cell">Email</th>
                  <th className="py-2 pr-3">RSVP Link</th>
                  <th className="py-2 pr-3 text-center">Status</th>
                  <th className="py-2 pr-3 text-center">
                    <button
                      onClick={() => handleSort('waiver')}
                      className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                      data-testid="th-sort-waiver"
                    >
                      Waiver <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-3 text-center">
                    <button
                      onClick={() => handleSort('jersey')}
                      className="flex items-center gap-1 hover:text-foreground transition-colors mx-auto"
                      data-testid="th-sort-jersey"
                    >
                      Jersey <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-3 text-center hidden md:table-cell">
                    <span className="inline-flex items-center gap-1" title="Most recent email open across all sends">
                      <Eye className="w-3 h-3" /> Opened
                    </span>
                  </th>
                  <th className="py-2 pr-3 text-center hidden md:table-cell">
                    <span className="inline-flex items-center gap-1" title="Most recent link click across all sends">
                      <MousePointerClick className="w-3 h-3" /> Clicked
                    </span>
                  </th>
                  <th className="py-2 pr-3 text-center hidden lg:table-cell">
                    <button
                      onClick={() => handleSort('sent')}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors mx-auto"
                      title="Sent for selected game"
                      data-testid="th-sort-sent"
                    >
                      <Send className="w-3 h-3" /> Sent <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-3 text-center hidden lg:table-cell">
                    <button
                      onClick={() => handleSort('opened')}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors mx-auto"
                      title="Opened for selected game"
                      data-testid="th-sort-opened"
                    >
                      <Eye className="w-3 h-3" /> Op. <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-3 text-center hidden lg:table-cell">
                    <button
                      onClick={() => handleSort('clicked')}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors mx-auto"
                      title="Clicked for selected game"
                      data-testid="th-sort-clicked"
                    >
                      <MousePointerClick className="w-3 h-3" /> Cl. <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-3 text-center hidden lg:table-cell">
                    <button
                      onClick={() => handleSort('rsvp')}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors mx-auto"
                      title="RSVP status for selected game"
                      data-testid="th-sort-rsvp"
                    >
                      <Check className="w-3 h-3" /> RSVP <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2 pr-2 text-center w-10">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(p => (
                  <tr
                    key={p.id}
                    className={`border-b border-border/40 hover:bg-accent/30 ${selectedIds.has(p.id) ? 'bg-primary/5' : ''}`}
                    data-testid={`row-dad-${p.id}`}
                  >
                    <td className="py-2 pr-2 align-middle">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.name}`}
                        checked={selectedIds.has(p.id)}
                        onChange={e => {
                          setSelectedIds(prev => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.id); else next.delete(p.id);
                            return next;
                          });
                        }}
                        className="rounded border-border accent-primary"
                        data-testid={`checkbox-dad-${p.id}`}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`/ball/p/${p.token}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium hover:underline flex items-center gap-1 text-foreground"
                          data-testid={`link-dad-${p.id}`}
                        >
                          {p.name}
                          <ExternalLink className="w-3 h-3 text-muted-foreground" />
                        </a>
                        <button
                          onClick={() => copyLink(p)}
                          title="Copy personal page link"
                          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
                          data-testid={`button-copy-link-${p.id}`}
                        >
                          {copiedId === p.id
                            ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                            : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <div className="text-xs text-muted-foreground sm:hidden mt-0.5">{p.email}</div>
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground hidden sm:table-cell">
                      {p.email}
                    </td>
                    <td className="py-2 pr-3" data-testid={`cell-rsvp-link-${p.id}`}>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <a
                          href={rsvpUrlFor(p)}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={rsvpUrlFor(p)}
                          className="hidden sm:inline-block max-w-[180px] truncate text-xs font-mono text-blue-500 hover:underline align-middle"
                          data-testid={`link-rsvp-${p.id}`}
                        >
                          …/p/{p.token}
                        </a>
                        <button
                          type="button"
                          onClick={() => copyText(rsvpUrlFor(p), p.id, p.name)}
                          title={`Copy ${rsvpUrlFor(p)}`}
                          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded shrink-0"
                          data-testid={`button-copy-rsvp-${p.id}`}
                        >
                          {copiedId === p.id
                            ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                            : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-center">
                      <div className="flex items-center justify-center gap-1 flex-wrap">
                        {p.isHost && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">host</Badge>
                        )}
                        {p.active ? (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-emerald-500 border-emerald-500/40">active</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-neutral-500">inactive</Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-center" data-testid={`badge-waiver-${p.id}`}>
                      {p.waiverSigned ? (
                        <span className="inline-flex flex-col items-center gap-0.5 text-emerald-500">
                          <span className="inline-flex items-center gap-1 text-[11px]">
                            <Check className="w-3.5 h-3.5 shrink-0" />
                            <span>
                              {p.waiverSignedAt
                                ? new Date(p.waiverSignedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                                : 'Signed'}
                            </span>
                          </span>
                          {p.waiverVersion && (
                            <span className="text-[10px] text-emerald-500/70 font-mono">{p.waiverVersion}</span>
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          Not signed
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-center text-xs" data-testid={`text-jersey-${p.id}`}>
                      {p.jerseySize ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-2 pr-3 text-center text-xs hidden md:table-cell" data-testid={`text-last-opened-${p.id}`}>
                      {(() => {
                        const t = formatRelativeTs(p.lastOpenedAt);
                        if (!t) return <span className="text-muted-foreground">—</span>;
                        return (
                          <span className="inline-flex flex-col items-center" title={`${t.abs} (${t.rel})`}>
                            <span className="text-foreground">{t.rel}</span>
                            <span className="text-[10px] text-muted-foreground">{t.abs}</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-2 pr-3 text-center text-xs hidden md:table-cell" data-testid={`text-last-clicked-${p.id}`}>
                      {(() => {
                        const t = formatRelativeTs(p.lastClickedAt);
                        if (!t) return <span className="text-muted-foreground">—</span>;
                        return (
                          <span className="inline-flex flex-col items-center text-blue-500" title={`${t.abs} (${t.rel})`}>
                            <span>{t.rel}</span>
                            <span className="text-[10px] opacity-70">{t.abs}</span>
                          </span>
                        );
                      })()}
                    </td>
                    {/* Engagement columns — scoped to selected game */}
                    {(() => {
                      const eng = engagementMap.get(p.id);
                      const latestSend = eng?.sends[0];
                      const clickedRsvpLink = latestSend?.lastClickLink != null &&
                        ['in', 'out', 'maybe'].includes(latestSend.lastClickLink) &&
                        !!latestSend.firstClickedAt;
                      const needsWaiver = !eng?.rsvpStatus && clickedRsvpLink && !p.waiverSigned;
                      return (
                        <>
                          <td className="py-2 pr-3 text-center hidden lg:table-cell" data-testid={`cell-eng-sent-${p.id}`}>
                            <CellSent send={latestSend} />
                          </td>
                          <td className="py-2 pr-3 text-center hidden lg:table-cell" data-testid={`cell-eng-opened-${p.id}`}>
                            <CellOpened send={latestSend} />
                          </td>
                          <td className="py-2 pr-3 text-center hidden lg:table-cell" data-testid={`cell-eng-clicked-${p.id}`}>
                            <CellClicked send={latestSend} />
                          </td>
                          <td className="py-2 pr-3 text-center hidden lg:table-cell" data-testid={`cell-eng-rsvp-${p.id}`}>
                            <CellRsvp status={eng?.rsvpStatus ?? null} needsWaiver={needsWaiver} />
                          </td>
                        </>
                      );
                    })()}
                    <td className="py-2 pr-2 text-center">
                      {p.isHost ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setResendTarget({ playerIds: [p.id], names: [p.name] })}
                          title={`Resend month invite to ${p.name}`}
                          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded inline-flex items-center"
                          data-testid={`button-resend-${p.id}`}
                        >
                          <Send className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={14} className="text-center text-muted-foreground py-8 text-sm">
                      {search ? 'No dads match that search.' : 'No players on the roster yet.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      {/* Resend confirm dialog */}
      <Dialog
        open={!!resendTarget}
        onOpenChange={(open) => { if (!open && !resend.isPending) setResendTarget(null); }}
      >
        <DialogContent data-testid="dialog-resend-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-4 h-4" />
              {resendTarget && resendTarget.playerIds.length === 1
                ? `Resend month invite to ${resendTarget.names[0]}?`
                : `Resend month invite to ${resendTarget?.playerIds.length ?? 0} dads?`}
            </DialogTitle>
            <DialogDescription>
              This re-sends the month-invite email (same template as the most recent blast).
              Useful when a dad reports the original landed in spam.
              {resendTarget && resendTarget.playerIds.length > 1 && (
                <span className="block mt-2 text-xs">
                  Recipients: {resendTarget.names.slice(0, 6).join(', ')}
                  {resendTarget.names.length > 6 && ` +${resendTarget.names.length - 6} more`}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setResendTarget(null)}
              disabled={resend.isPending}
              data-testid="button-resend-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => resendTarget && resend.mutate({ playerIds: resendTarget.playerIds, dryRun: true })}
              disabled={resend.isPending}
              data-testid="button-resend-dryrun"
            >
              Dry run
            </Button>
            <Button
              type="button"
              onClick={() => resendTarget && resend.mutate({ playerIds: resendTarget.playerIds, dryRun: false })}
              disabled={resend.isPending}
              data-testid="button-resend-confirm"
            >
              {resend.isPending
                ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Sending…</>
                : <>Send for real</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Blast Summary ────────────────────────────────────────────────────────
//
// Top-of-page headline card. Picks the "most-recently-blasted" game
// (max invite_sent_at) so Tony sees how the live blast is performing
// without clicking into a game first. Falls back to the next upcoming
// game when no per-game invite_sent_at exists (month-invite blasts
// don't stamp invite_sent_at — they touch all upcoming games at once).

interface BlastSummary {
  gameId: string;
  recipientCount: number;
  blastSentAt: string | null;
  totalSent: number;
  totalDelivered: number;
  totalOpened: number;
  totalClicked: number;
  totalBounced: number;
  totalRsvpYes: number;
  totalRsvpNo: number;
  totalRsvpMaybe: number;
  totalNoResponse: number;
  openRatePercent: number;
  clickRatePercent: number;
  responseRatePercent: number;
  appleMailFlagged: number;
}

function BlastSummaryCard({ games }: { games: AdminGame[] }) {
  // Pick most-recent invite_sent_at, otherwise next upcoming.
  const todayIso = new Date().toISOString().slice(0, 10);
  const blasted = games
    .filter(g => g.inviteSentAt)
    .sort((a, b) => (b.inviteSentAt ?? '').localeCompare(a.inviteSentAt ?? ''))[0];
  const upcoming = games
    .filter(g => g.gameDate >= todayIso)
    .sort((a, b) => a.gameDate.localeCompare(b.gameDate))[0];
  const target = blasted ?? upcoming;

  const query = useQuery<BlastSummary>({
    queryKey: ['ball-admin', 'blast-summary', target?.id ?? null],
    queryFn: async () => {
      const r = await fetch(`/api/ball/admin/blast-summary?gameId=${target!.id}`, { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load blast summary');
      return r.json();
    },
    enabled: !!target,
  });

  if (!target) return null;

  return (
    <Card data-testid="card-blast-summary">
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Megaphone className="w-4 h-4 text-muted-foreground" />
            Blast performance — {formatDate(target.gameDate)}
          </span>
          {query.data?.blastSentAt && (() => {
            const t = formatRelativeTs(query.data.blastSentAt);
            if (!t) return null;
            return (
              <span className="text-xs font-normal text-muted-foreground" data-testid="text-blast-sent-at">
                sent {t.rel} · {t.abs}
              </span>
            );
          })()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : query.data ? (
          <>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
              <BlastTile
                testid="tile-blast-sent"
                label="Sent"
                value={query.data.totalSent}
                sub={query.data.totalBounced > 0 ? `${query.data.totalBounced} bounced` : null}
                icon={<Send className="w-3.5 h-3.5" />}
              />
              <BlastTile
                testid="tile-blast-opened"
                label="Opened"
                value={query.data.totalOpened}
                sub={`${query.data.openRatePercent}% open rate`}
                icon={<Eye className="w-3.5 h-3.5" />}
                tone="emerald"
              />
              <BlastTile
                testid="tile-blast-clicked"
                label="Clicked"
                value={query.data.totalClicked}
                sub={`${query.data.clickRatePercent}% click rate`}
                icon={<MousePointerClick className="w-3.5 h-3.5" />}
                tone="blue"
              />
              <BlastTile
                testid="tile-blast-yes"
                label="RSVP Yes"
                value={query.data.totalRsvpYes}
                sub={`${query.data.responseRatePercent}% responded`}
                icon={<Check className="w-3.5 h-3.5" />}
                tone="emerald"
              />
              <BlastTile
                testid="tile-blast-no"
                label="RSVP No"
                value={query.data.totalRsvpNo}
                sub={query.data.totalRsvpMaybe > 0 ? `${query.data.totalRsvpMaybe} maybe` : null}
                icon={<X className="w-3.5 h-3.5" />}
              />
              <BlastTile
                testid="tile-blast-no-response"
                label="No response"
                value={query.data.totalNoResponse}
                sub={`of ${query.data.recipientCount} dads`}
                icon={<HelpCircle className="w-3.5 h-3.5" />}
                tone={query.data.totalNoResponse > 0 ? 'amber' : undefined}
              />
            </div>
            {query.data.appleMailFlagged > 0 && (
              <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5" data-testid="text-apple-mail-note">
                <AlertCircle className="w-3.5 h-3.5" />
                {query.data.appleMailFlagged} open{query.data.appleMailFlagged === 1 ? '' : 's'} look like Apple Mail Privacy prefetches (false positives — these dads may not have actually opened the email).
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground py-3">No blast data yet for this game.</p>
        )}
      </CardContent>
    </Card>
  );
}

function BlastTile({
  label, value, sub, icon, tone, testid,
}: {
  label: string;
  value: number;
  sub: string | null;
  icon: React.ReactNode;
  tone?: 'emerald' | 'blue' | 'amber';
  testid: string;
}) {
  const toneFg =
    tone === 'emerald' ? 'text-emerald-500'
    : tone === 'blue' ? 'text-blue-500'
    : tone === 'amber' ? 'text-amber-500'
    : 'text-muted-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid={testid}>
      <div className={`text-xs flex items-center gap-1 ${toneFg}`}>
        {icon} {label}
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; fg: string; label: string }> = {
    scheduled: { bg: 'bg-blue-500/10', fg: 'text-blue-400', label: 'Scheduled' },
    on: { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', label: 'ON' },
    off: { bg: 'bg-red-500/10', fg: 'text-red-400', label: 'OFF' },
    done: { bg: 'bg-neutral-500/10', fg: 'text-neutral-400', label: 'Done' },
  };
  const s = styles[status] ?? styles.scheduled;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.bg} ${s.fg}`}>
      {s.label}
    </span>
  );
}

// ─── Email Engagement types + cells ──────────────────────────────────────
// EngagementSection removed — engagement is now part of DadsRosterSection.

interface EngagementSend {
  id: string;
  template: string;
  subject: string;
  createdAt: string;
  sentAt: string | null;
  bouncedAt: string | null;
  bounceReason: string | null;
  sendError: string | null;
  openedAt: string | null;
  openCount: number;
  firstClickedAt: string | null;
  clickCount: number;
  lastClickLink: string | null;
  looksLikeAppleMail: boolean;
}

interface EngagementRow {
  playerId: string;
  name: string;
  email: string;
  rsvpStatus: 'in' | 'out' | 'maybe' | 'pending_reconfirm' | null;
  rsvpAt: string | null;
  sends: EngagementSend[];
}

interface EngagementPayload {
  gameId: string;
  gameDate: string;
  rows: EngagementRow[];
}


function Stat({
  icon, label, value, variant = 'neutral', hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  variant?: 'good' | 'warn' | 'neutral';
  hint?: string;
}) {
  const color =
    variant === 'good' ? 'text-emerald-500'
    : variant === 'warn' ? 'text-red-500'
    : 'text-muted-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className={`flex items-center gap-1.5 text-xs ${color}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function CellWaiver({
  waiver,
  playerId,
}: {
  waiver: { signed: boolean; version: string | null; signedAt: string | null } | undefined;
  playerId: string;
}) {
  if (!waiver) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (waiver.signed && waiver.signedAt) {
    const date = new Date(waiver.signedAt).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: '2-digit',
    });
    return (
      <span
        data-testid={`badge-waiver-signed-${playerId}`}
        className="inline-flex items-center gap-1 text-[11px] text-emerald-500"
        title={`Signed ${new Date(waiver.signedAt).toLocaleString()} (${waiver.version})`}
      >
        <Check className="w-3.5 h-3.5" /> Signed {date}
      </span>
    );
  }
  return (
    <span
      data-testid={`badge-waiver-unsigned-${playerId}`}
      className="inline-flex items-center gap-1 text-[11px] text-amber-500"
      title="Player has not signed the current waiver version"
    >
      <AlertTriangle className="w-3.5 h-3.5" /> Not signed
    </span>
  );
}

function CellSent({ send }: { send: EngagementSend | undefined }) {
  if (!send) return <span className="text-muted-foreground">—</span>;
  if (send.bouncedAt) {
    return (
      <span className="inline-flex items-center gap-1 text-red-500" title={send.bounceReason ?? send.sendError ?? 'bounced'}>
        <AlertTriangle className="w-3.5 h-3.5" />
        <span className="text-xs">bounce</span>
      </span>
    );
  }
  if (send.sentAt) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-500" title={`Sent ${new Date(send.sentAt).toLocaleString()}`}>
        <Check className="w-3.5 h-3.5" />
      </span>
    );
  }
  if (send.sendError) {
    return (
      <span className="inline-flex items-center gap-1 text-red-500" title={send.sendError}>
        <X className="w-3.5 h-3.5" />
      </span>
    );
  }
  return <span className="text-muted-foreground">queued</span>;
}

function CellOpened({ send }: { send: EngagementSend | undefined }) {
  if (!send) return <span className="text-muted-foreground">—</span>;
  if (!send.openedAt) return <span className="text-muted-foreground">—</span>;
  if (send.looksLikeAppleMail) {
    return (
      <span className="inline-flex items-center gap-1 text-yellow-500" title="Apple Mail prefetch (likely auto-open, not human)">
        <Eye className="w-3.5 h-3.5" />
        <span className="text-[10px]">~apple</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-emerald-500" title={`First open ${new Date(send.openedAt).toLocaleString()} (${send.openCount} total)`}>
      <Eye className="w-3.5 h-3.5" />
      {send.openCount > 1 && <span className="text-[10px]">×{send.openCount}</span>}
    </span>
  );
}

function CellClicked({ send }: { send: EngagementSend | undefined }) {
  if (!send) return <span className="text-muted-foreground">—</span>;
  if (!send.firstClickedAt) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-emerald-500" title={`Clicked ${new Date(send.firstClickedAt).toLocaleString()} (${send.lastClickLink ?? 'link'})`}>
      <MousePointerClick className="w-3.5 h-3.5" />
      {send.lastClickLink && <span className="text-[10px] uppercase">{send.lastClickLink}</span>}
    </span>
  );
}

function CellRsvp({ status, needsWaiver }: { status: EngagementRow['rsvpStatus']; needsWaiver?: boolean }) {
  if (!status) {
    if (needsWaiver) {
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-400" title="Clicked an RSVP button but has no active waiver — waiver required before RSVP is recorded">
          <AlertTriangle className="w-3 h-3" /> needs waiver
        </span>
      );
    }
    return <span className="text-muted-foreground">—</span>;
  }
  if (status === 'in') return <span className="text-emerald-500 text-xs font-semibold">IN</span>;
  if (status === 'out') return <span className="text-neutral-500 text-xs">out</span>;
  if (status === 'pending_reconfirm') return <span className="text-yellow-500 text-xs">pending</span>;
  return <span className="text-xs">{status}</span>;
}

// ─── Manual per-game blast + decision email triggers ─────────────────────

function ManualSendSection({
  game,
  confirmed,
  activePlayers,
}: {
  game: AdminGame;
  confirmed: GameDetail['confirmed'];
  activePlayers: number;
}) {
  const queryClient = useQueryClient();
  const [blastOpen, setBlastOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState<null | 'on' | 'off'>(null);

  const blastMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/ball/admin/games/${game.id}/send-invite-blast`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json as { ok: true; sent: number; failed: number; recipients: number; emailSendIds: string[] };
    },
    onSuccess: (data) => {
      toast({ title: `Sent ${data.sent} invites`, description: `${data.recipients} dads on the list · ${data.failed} failed` });
      setBlastOpen(false);
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
    },
    onError: (e: Error) => {
      toast({ title: 'Invite blast failed', description: e.message, variant: 'destructive' });
    },
  });

  const decisionMutation = useMutation({
    mutationFn: async ({ decision, force }: { decision: 'on' | 'off'; force?: boolean }) => {
      const r = await fetch(`/api/ball/admin/games/${game.id}/send-decision-email`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, force: !!force }),
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json as { ok: true; sent: number; failed: number; recipients: number; status: 'on' | 'off' };
    },
    onSuccess: (data) => {
      toast({
        title: `Decision sent — game marked ${data.status.toUpperCase()}`,
        description: `Notified ${data.sent}/${data.recipients} players${data.failed ? ` · ${data.failed} failed` : ''}`,
      });
      setDecisionOpen(null);
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
    },
    onError: (e: Error) => {
      toast({ title: 'Decision email failed', description: e.message, variant: 'destructive' });
    },
  });

  // Server filters host out for both routes; mirror that filter for preview.
  const nonHostConfirmed = confirmed.filter(c => !c.isHost);
  const confirmedNonHostNames = nonHostConfirmed.map(c => c.name);
  const recipientCount = nonHostConfirmed.length;
  // Invite blast recipients = all active non-host players (one host).
  const blastRecipientCount = Math.max(0, activePlayers - confirmed.filter(c => c.isHost).length);
  const blastDisabled = game.status !== 'scheduled';
  // minPlayers is host-inclusive (matches game.counts.in semantics).
  // Detail endpoint historically didn't include `counts` on `game` — fall back to
  // confirmed.length (host-inclusive, same semantic) so older backends don't crash the page.
  const inCount = game.counts?.in ?? confirmed.length;
  const onDisabled = inCount < game.minPlayers;

  // Subject previews — kept in sync with server-side template generators.
  const subjectOn = `🟢 Game ON tonight — Ball at Club34, 6pm`;
  const subjectOff = `🔴 Tonight's ball is off — see you next Wednesday`;
  const previewSubject = decisionOpen === 'on' ? subjectOn : subjectOff;

  return (
    <Card className="mt-4" data-testid="card-manual-send">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="w-4 h-4 text-muted-foreground" />
          Manual Send — outside the cron schedule
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setBlastOpen(true)}
            disabled={blastDisabled}
            data-testid="button-send-invite-blast"
            title={blastDisabled ? 'Only available when game status is scheduled' : ''}
          >
            <Megaphone className="w-4 h-4 mr-2" />
            Send Invite Blast
          </Button>
          <Button
            className="bg-emerald-500 hover:bg-emerald-600 text-black"
            onClick={() => setDecisionOpen('on')}
            disabled={onDisabled}
            data-testid="button-send-decision-on"
            title={onDisabled ? `Need at least ${game.minPlayers} confirmed (have ${inCount})` : ''}

          >
            <Check className="w-4 h-4 mr-2" />
            Game is ON
          </Button>
          <Button
            variant="destructive"
            onClick={() => setDecisionOpen('off')}
            data-testid="button-send-decision-off"
          >
            <X className="w-4 h-4 mr-2" />
            Game is OFF
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          These fire immediately and coexist with the automatic crons.
        </p>
      </CardContent>

      {/* Invite blast confirmation modal */}
      <Dialog open={blastOpen} onOpenChange={(o) => !blastMutation.isPending && setBlastOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="w-5 h-5" /> Send Invite Blast
            </DialogTitle>
            <DialogDescription>
              About to email every active non-host dad inviting them to RSVP for{' '}
              <strong>{formatDate(game.gameDate)}</strong>, {game.startTime}–{game.endTime}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
              <div className="text-xs text-muted-foreground">Subject preview</div>
              <div className="font-mono text-xs">🏀 Club34 Ball — RSVP for 1 Wednesday game</div>
            </div>
            <div className="text-muted-foreground">
              Recipients: <strong className="text-foreground">~{blastRecipientCount}</strong>{' '}
              active dads on the roster (excluding host).
            </div>
            {blastMutation.error && (
              <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
                {(blastMutation.error as Error).message}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlastOpen(false)} disabled={blastMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => blastMutation.mutate()} disabled={blastMutation.isPending} data-testid="button-confirm-invite-blast">
              {blastMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Megaphone className="w-4 h-4 mr-2" />}
              Send blast now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decision email confirmation modal */}
      <Dialog open={decisionOpen !== null} onOpenChange={(o) => !decisionMutation.isPending && !o && setDecisionOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gavel className="w-5 h-5" />
              {decisionOpen === 'on' ? 'Mark game ON and notify' : 'Mark game OFF and notify'}
            </DialogTitle>
            <DialogDescription>
              About to set <strong>{formatDate(game.gameDate)}</strong> to{' '}
              <strong>{decisionOpen === 'on' ? 'ON' : 'OFF'}</strong> and email the {recipientCount} confirmed
              {recipientCount === 1 ? ' player' : ' players'}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-sm">
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1">
              <div className="text-xs text-muted-foreground">Subject preview</div>
              <div className="font-mono text-xs">{previewSubject}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Recipients ({confirmedNonHostNames.length})</div>
              <div className="max-h-32 overflow-auto rounded border border-border bg-background/40 p-2 text-xs leading-relaxed" data-testid="text-decision-recipients">
                {confirmedNonHostNames.length > 0 ? confirmedNonHostNames.join(' · ') : <span className="text-muted-foreground italic">No confirmed players — email will not be sent to anyone.</span>}
              </div>
            </div>
            {(game.status === 'on' || game.status === 'off') && (
              <div className="text-xs rounded p-2 bg-yellow-500/10 border border-yellow-500/30 text-yellow-300">
                Game is already <strong>{game.status.toUpperCase()}</strong>. Sending again will re-email everyone (force).
              </div>
            )}
            {decisionMutation.error && (
              <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
                {(decisionMutation.error as Error).message}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionOpen(null)} disabled={decisionMutation.isPending}>
              Cancel
            </Button>
            <Button
              className={decisionOpen === 'on' ? 'bg-emerald-500 hover:bg-emerald-600 text-black' : ''}
              variant={decisionOpen === 'off' ? 'destructive' : 'default'}
              onClick={() => decisionMutation.mutate({
                decision: decisionOpen as 'on' | 'off',
                force: game.status === 'on' || game.status === 'off',
              })}
              disabled={decisionMutation.isPending || decisionOpen === null}
              data-testid="button-confirm-decision"
            >
              {decisionMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
              {decisionOpen === 'on' ? 'Send "Game ON" emails' : 'Send "Game OFF" emails'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ─── Create Game Dialog ──────────────────────────────────────────────────

function CreateGameDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const rosterQuery = useQuery<{ players: RosterPlayer[] }>({
    queryKey: ['ball-admin', 'players-roster'],
    queryFn: async () => {
      const r = await fetch('/api/ball/admin/players', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load roster');
      return r.json();
    },
    // Auto-refresh so stale RSVP/waiver state doesn't linger in the admin UI.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
  const rosterPlayers = rosterQuery.data?.players ?? [];
  const totalActive = rosterPlayers.filter(p => p.active).length;
  const nonHostActive = rosterPlayers.filter(p => p.active && !p.isHost).length;
  // Default to next Wednesday at 18:00
  const nextWed = (() => {
    const d = new Date();
    const dayOfWeek = d.getDay();
    const daysToWed = (3 - dayOfWeek + 7) % 7 || 7;
    d.setDate(d.getDate() + daysToWed);
    return d.toISOString().slice(0, 10);
  })();
  const [date, setDate] = useState(nextWed);
  const [startTime, setStartTime] = useState('18:00');
  const [endTime, setEndTime] = useState('20:00');
  const [minPlayers, setMinPlayers] = useState(6);
  const [notes, setNotes] = useState('');
  const [repeatWeekly, setRepeatWeekly] = useState(1);
  const [sendInvite, setSendInvite] = useState(false);

  const createMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/ball/admin/games', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date, startTime, endTime, minPlayers,
          notes: notes || null, repeatWeekly,
          sendInvite,
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
      setOpen(false);
      // Reset form
      setDate(nextWed); setRepeatWeekly(1); setSendInvite(false); setNotes('');
      // Show toast-y alert with details
      const msg = data.inviteResult
        ? `Created ${data.created?.length ?? 0} game(s). Sent ${data.inviteResult.sent} invites.`
        : `Created ${data.created?.length ?? 0} game(s).`;
      alert(msg);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <CalendarPlus className="w-4 h-4 mr-2" />
          New Game
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create New Game</DialogTitle>
          <DialogDescription>
            Single game or recurring weekly series. Optionally fire the month-invite blast after.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label htmlFor="game-date">Date</Label>
            <Input
              id="game-date"
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="game-start">Start</Label>
              <Input
                id="game-start"
                type="time"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="game-end">End</Label>
              <Input
                id="game-end"
                type="time"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="min-players">Min players</Label>
              <Input
                id="min-players"
                type="number"
                min="2" max="20"
                value={minPlayers}
                onChange={e => setMinPlayers(Number(e.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="repeat-weekly">Repeat weekly</Label>
              <Input
                id="repeat-weekly"
                type="number"
                min="1" max="52"
                value={repeatWeekly}
                onChange={e => setRepeatWeekly(Number(e.target.value))}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {repeatWeekly === 1 ? 'Single game' : `${repeatWeekly} games, 7 days apart`}
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              placeholder="e.g. 'Bring water — court will be hot'"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer rounded-md border border-border p-3 hover:bg-accent">
            <input
              type="checkbox"
              checked={sendInvite}
              onChange={e => setSendInvite(e.target.checked)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-sm font-medium">Send invite blast immediately</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {rosterQuery.isLoading
                  ? 'Emails all active dads except you (…) with a month-invite listing every upcoming Wednesday. They can RSVP yes/no per game.'
                  : rosterQuery.isError || totalActive === 0
                  ? 'Emails all active dads except you with a month-invite listing every upcoming Wednesday. They can RSVP yes/no per game.'
                  : `Emails all active dads except you (${nonHostActive} of ${totalActive} total) with a month-invite listing every upcoming Wednesday. They can RSVP yes/no per game.`}
              </div>
            </div>
          </label>

          {createMutation.error && (
            <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
              {(createMutation.error as Error).message}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !date}
          >
            {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CalendarPlus className="w-4 h-4 mr-2" />}
            {sendInvite ? 'Create & Send Invites' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Backfill Section ─────────────────────────────────────────────────────
//
// One-time admin trigger to reconcile historic email clicks with ball_rsvps.
// Safe to run multiple times — never overwrites existing RSVPs.

interface BackfillSummary {
  scanned: number;
  inserted: number;
  skipped_existing: number;
  skipped_no_waiver: number;
  skipped_host: number;
  skipped_game_closed: number;
  errors: number;
}

function BackfillSection() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<BackfillSummary | null>(null);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/ball/admin/backfill-email-clicks', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return json as { ok: true } & BackfillSummary;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ['ball-admin'] });
      toast({
        title: `Backfill complete`,
        description: `Scanned ${data.scanned} clicks · inserted ${data.inserted} RSVPs · ${data.skipped_existing} already had RSVPs`,
      });
      setOpen(false);
    },
    onError: (e: Error) => {
      toast({ title: 'Backfill failed', description: e.message, variant: 'destructive' });
    },
  });

  return (
    <Card data-testid="card-backfill-section">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MousePointerClick className="w-4 h-4 text-muted-foreground" />
            Reconcile Email-Click RSVPs
          </CardTitle>
          <Dialog open={open} onOpenChange={(o) => !backfillMutation.isPending && setOpen(o)}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-open-backfill-dialog">
                Run Backfill
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <MousePointerClick className="w-5 h-5" /> Backfill Email-Click RSVPs
                </DialogTitle>
                <DialogDescription>
                  Scans all email click history for dads who clicked <strong>In / Out / Maybe</strong> but have no RSVP recorded. Inserts the missing RSVPs. Safe to run multiple times — never overwrites existing entries.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 py-2 text-sm">
                <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
                  <div className="font-medium">What this does</div>
                  <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                    <li>Finds every click row where the dad clicked IN / OUT / MAYBE and has a game_id</li>
                    <li>If no RSVP exists for that (player, game), inserts one tagged <code>source=email-click-backfill</code></li>
                    <li>Players without an active waiver are skipped (they need to sign on the player page first)</li>
                    <li>Existing RSVPs are never changed</li>
                  </ul>
                </div>
                {backfillMutation.error && (
                  <div className="text-sm text-red-500 bg-red-500/10 rounded p-2">
                    {(backfillMutation.error as Error).message}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)} disabled={backfillMutation.isPending}>
                  Cancel
                </Button>
                <Button onClick={() => backfillMutation.mutate()} disabled={backfillMutation.isPending} data-testid="button-confirm-backfill">
                  {backfillMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <MousePointerClick className="w-4 h-4 mr-2" />}
                  Run Backfill Now
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Reconciles historic email clicks that never turned into RSVPs. Run once after deployment to fix existing gaps.
        </p>
      </CardHeader>
      {result && (
        <CardContent>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">
            {[
              { label: 'Scanned', value: result.scanned, color: '' },
              { label: 'Inserted', value: result.inserted, color: 'text-emerald-500' },
              { label: 'Existing', value: result.skipped_existing, color: 'text-muted-foreground' },
              { label: 'No Waiver', value: result.skipped_no_waiver, color: result.skipped_no_waiver > 0 ? 'text-amber-400' : 'text-muted-foreground' },
              { label: 'Closed', value: result.skipped_game_closed, color: 'text-muted-foreground' },
              { label: 'Errors', value: result.errors, color: result.errors > 0 ? 'text-red-400' : 'text-muted-foreground' },
            ].map(({ label, value, color }) => (
              <div key={label} className="rounded border border-border bg-card p-2">
                <div className={`text-xl font-bold ${color}`}>{value}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Activity Feed ────────────────────────────────────────────────────────
//
// Collapsible bottom panel showing the most recent ball-namespaced audit
// rows (admin actions, RSVP submissions, waiver signs, cleanup runs…).
// Reads from GET /api/ball/admin/audit?limit=50 which filters
// system_audit_log on edge_function LIKE 'ball-%'.

interface BallAuditEvent {
  id: string;
  createdAt: string;
  edgeFunction: string;
  eventType: string;
  severity: 'info' | 'warn' | 'warning' | 'error' | 'critical' | string | null;
  status: string | null;
  actorName: string | null;
  actorRole: string | null;
  summary: string | null;
  detail: Record<string, unknown> | null;
  durationMs: number | null;
  correlationId: string | null;
}

function severityClass(sev: string | null): string {
  switch ((sev ?? '').toLowerCase()) {
    case 'error':
    case 'critical':
      return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'warn':
    case 'warning':
      return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default:
      return 'bg-muted text-muted-foreground border-border';
  }
}

function ActivitySection() {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const query = useQuery<{ ok: boolean; count: number; events: BallAuditEvent[] }>({
    queryKey: ['/api/ball/admin/audit', { limit: 50 }],
    queryFn: async () => {
      const res = await fetch('/api/ball/admin/audit?limit=50', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load activity');
      return res.json();
    },
    enabled: open,
    refetchInterval: open ? 30000 : false,
  });

  const events = query.data?.events ?? [];

  return (
    <Card data-testid="card-activity-feed">
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
        data-testid="button-toggle-activity"
      >
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Activity
            {open && query.data && (
              <Badge variant="secondary" className="ml-1 text-xs">
                {query.data.count}
              </Badge>
            )}
          </CardTitle>
          {open ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
        {!open && (
          <p className="text-xs text-muted-foreground mt-1">
            Recent admin actions, RSVPs, waiver signs, and cron runs.
          </p>
        )}
      </CardHeader>
      {open && (
        <CardContent>
          {query.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : query.isError ? (
            <div className="text-sm text-red-400">Failed to load activity feed.</div>
          ) : events.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center">No ball activity yet.</div>
          ) : (
            <ul className="divide-y divide-border/40 -mx-2">
              {events.map(ev => {
                const isExpanded = expandedId === ev.id;
                const ts = formatRelativeTs(ev.createdAt);
                return (
                  <li
                    key={ev.id}
                    className="px-2 py-2 hover:bg-accent/30 transition-colors"
                    data-testid={`row-audit-${ev.id}`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : ev.id)}
                      className="w-full text-left flex items-start gap-3"
                    >
                      <span className={`shrink-0 mt-0.5 inline-flex items-center text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${severityClass(ev.severity)}`}>
                        {ev.edgeFunction.replace(/^ball-/, '')}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          <span className="font-medium">{ev.eventType}</span>
                          {ev.summary && (
                            <span className="text-muted-foreground"> — {ev.summary}</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                          {ev.actorName && <span>{ev.actorName}</span>}
                          {ts && <span title={ts.abs}>{ts.rel}</span>}
                          {typeof ev.durationMs === 'number' && <span>{ev.durationMs}ms</span>}
                          {ev.status && ev.status !== 'success' && (
                            <span className="text-amber-400">{ev.status}</span>
                          )}
                        </div>
                      </div>
                    </button>
                    {isExpanded && ev.detail && (
                      <pre className="mt-2 ml-2 p-2 bg-muted/50 rounded text-xs overflow-x-auto" data-testid={`detail-audit-${ev.id}`}>
                        {JSON.stringify(ev.detail, null, 2)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}
