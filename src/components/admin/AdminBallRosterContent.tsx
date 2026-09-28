/**
 * AdminBallRosterContent — permanent "people view" of every Ball dad.
 *
 * Complements AdminBallContent (the per-game view) with a stable roster
 * screen showing contact info, waiver status, and season engagement for
 * every dad in `ball_players`.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

// See AdminBallContent.tsx for the rationale — JWT must travel for
// /api/ball/admin/* to authenticate on production.
const fetch = (url: string, init?: RequestInit) =>
  fetchWithAuth(url, init as RequestInit & { body?: string });
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Users,
  Search,
  Loader2,
  ArrowUpDown,
  Check,
  AlertTriangle,
  Gavel,
  Mail,
  Phone,
  Shirt as ShirtIcon,
} from 'lucide-react';

interface RosterPlayer {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  token: string;
  isHost: boolean;
  active: boolean;
  jerseySize: string | null;
  waiverSigned: boolean;
  waiverVersion: string | null;
  waiverSignedAt: string | null;
  // Engagement rollups — defaults applied via normalizePlayer below so an
  // older backend response (missing these fields) still renders safely.
  gamesInvited?: number;
  rsvpCounts?: { in: number; out: number; maybe: number };
  lastRespondedAt?: string | null;
}

interface NormalizedRosterPlayer extends RosterPlayer {
  phone: string | null;
  gamesInvited: number;
  rsvpCounts: { in: number; out: number; maybe: number };
  lastRespondedAt: string | null;
}

function normalizePlayer(p: RosterPlayer): NormalizedRosterPlayer {
  return {
    ...p,
    phone: p.phone ?? null,
    gamesInvited: p.gamesInvited ?? 0,
    rsvpCounts: {
      in: p.rsvpCounts?.in ?? 0,
      out: p.rsvpCounts?.out ?? 0,
      maybe: p.rsvpCounts?.maybe ?? 0,
    },
    lastRespondedAt: p.lastRespondedAt ?? null,
  };
}

type SortCol =
  | 'name'
  | 'email'
  | 'waiver'
  | 'invited'
  | 'in'
  | 'out'
  | 'maybe'
  | 'last';
type SortDir = 'asc' | 'desc';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return 'Today';
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default function AdminBallRosterContent() {
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const query = useQuery<{ players: RosterPlayer[] }>({
    queryKey: ['ball-admin', 'players-roster'],
    queryFn: async () => {
      const r = await fetch('/api/ball/admin/players', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load roster');
      return r.json();
    },
  });

  const players = useMemo(
    () => (query.data?.players ?? []).map(normalizePlayer),
    [query.data],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return players.filter(p => {
      if (!showInactive && !p.active) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [players, search, showInactive]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'email':
          cmp = a.email.localeCompare(b.email);
          break;
        case 'waiver':
          cmp = (b.waiverSigned ? 1 : 0) - (a.waiverSigned ? 1 : 0);
          break;
        case 'invited':
          cmp = a.gamesInvited - b.gamesInvited;
          break;
        case 'in':
          cmp = a.rsvpCounts.in - b.rsvpCounts.in;
          break;
        case 'out':
          cmp = a.rsvpCounts.out - b.rsvpCounts.out;
          break;
        case 'maybe':
          cmp = a.rsvpCounts.maybe - b.rsvpCounts.maybe;
          break;
        case 'last': {
          const at = a.lastRespondedAt ? Date.parse(a.lastRespondedAt) : 0;
          const bt = b.lastRespondedAt ? Date.parse(b.lastRespondedAt) : 0;
          cmp = at - bt;
          break;
        }
      }
      const primary = sortDir === 'asc' ? cmp : -cmp;
      return primary !== 0 ? primary : a.name.localeCompare(b.name);
    });
    return arr;
  }, [filtered, sortCol, sortDir]);

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir(col === 'name' || col === 'email' ? 'asc' : 'desc');
    }
  }

  const activeCount = players.filter(p => p.active).length;
  const inactiveCount = players.length - activeCount;
  const signedCount = players.filter(p => p.waiverSigned && p.active).length;
  const missingWaiver = players.filter(p => !p.waiverSigned && p.active && !p.isHost).length;

  return (
    <div className="space-y-6" data-testid="page-ball-roster">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2">
          <Users className="w-6 h-6 text-muted-foreground" />
          Ball Roster
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Every dad in the league at a glance — contact info, waiver status, and season engagement.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          testId="stat-active-dads"
          icon={<Users className="w-4 h-4" />}
          label="Active dads"
          value={query.isLoading ? '—' : String(activeCount)}
        />
        <StatCard
          testId="stat-inactive-dads"
          icon={<Users className="w-4 h-4" />}
          label="Inactive"
          value={query.isLoading ? '—' : String(inactiveCount)}
          muted
        />
        <StatCard
          testId="stat-signed-waivers"
          icon={<Gavel className="w-4 h-4" />}
          label="Waiver signed"
          value={query.isLoading ? '—' : String(signedCount)}
          tone="good"
        />
        <StatCard
          testId="stat-missing-waivers"
          icon={<AlertTriangle className="w-4 h-4" />}
          label="Missing waiver"
          value={query.isLoading ? '—' : String(missingWaiver)}
          tone={missingWaiver > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            Full Roster
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder="Filter by name, email, or phone…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9"
                data-testid="input-roster-search"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                id="show-inactive"
                checked={showInactive}
                onCheckedChange={setShowInactive}
                data-testid="switch-show-inactive"
              />
              <Label htmlFor="show-inactive" className="text-sm cursor-pointer">
                Show inactive
              </Label>
            </div>
          </div>

          {query.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : query.isError ? (
            <div className="text-sm text-red-500 py-6 text-center">
              Failed to load roster.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b">
                    <th className="py-2 pr-4">
                      <SortBtn col="name" sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Name</SortBtn>
                    </th>
                    <th className="py-2 pr-4 hidden md:table-cell">
                      <SortBtn col="email" sortCol={sortCol} sortDir={sortDir} onSort={handleSort}>Contact</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">Flags</th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="waiver" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>Waiver</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">Jersey</th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="invited" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>Invited</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="in" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>In</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="out" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>Out</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="maybe" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>Maybe</SortBtn>
                    </th>
                    <th className="py-2 pr-3 text-center">
                      <SortBtn col="last" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} center>Last Response</SortBtn>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(p => (
                    <tr
                      key={p.id}
                      className={`border-b border-border/40 hover:bg-accent/30 ${!p.active ? 'opacity-60' : ''}`}
                      data-testid={`row-roster-${p.id}`}
                    >
                      <td className="py-2 pr-4">
                        <div className="font-medium" data-testid={`text-name-${p.id}`}>{p.name}</div>
                        <div className="text-xs text-muted-foreground md:hidden mt-0.5">
                          {p.email}
                          {p.phone && <> · {p.phone}</>}
                        </div>
                      </td>
                      <td className="py-2 pr-4 hidden md:table-cell text-xs text-muted-foreground">
                        <div className="flex items-center gap-1" data-testid={`text-email-${p.id}`}>
                          <Mail className="w-3 h-3 shrink-0" />
                          <a href={`mailto:${p.email}`} className="hover:underline truncate">{p.email}</a>
                        </div>
                        {p.phone && (
                          <div className="flex items-center gap-1 mt-0.5" data-testid={`text-phone-${p.id}`}>
                            <Phone className="w-3 h-3 shrink-0" />
                            <a href={`tel:${p.phone}`} className="hover:underline">{p.phone}</a>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-center">
                        <div className="flex items-center justify-center gap-1 flex-wrap">
                          {p.isHost && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0" data-testid={`badge-host-${p.id}`}>
                              host
                            </Badge>
                          )}
                          {p.active ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 text-emerald-500 border-emerald-500/40"
                              data-testid={`badge-active-${p.id}`}
                            >
                              active
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 text-neutral-500"
                              data-testid={`badge-inactive-${p.id}`}
                            >
                              inactive
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-center" data-testid={`cell-waiver-${p.id}`}>
                        {p.waiverSigned ? (
                          <span className="inline-flex flex-col items-center gap-0.5 text-emerald-500">
                            <span className="inline-flex items-center gap-1 text-[11px]">
                              <Check className="w-3.5 h-3.5 shrink-0" />
                              <span>{fmtDate(p.waiverSignedAt)}</span>
                            </span>
                            {p.waiverVersion && (
                              <span className="text-[10px] text-emerald-500/70 font-mono">
                                {p.waiverVersion}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Not signed
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-center text-xs" data-testid={`cell-jersey-${p.id}`}>
                        {p.jerseySize ? (
                          <span className="inline-flex items-center gap-1">
                            <ShirtIcon className="w-3 h-3 text-muted-foreground" />
                            {p.jerseySize}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-center text-sm tabular-nums" data-testid={`cell-invited-${p.id}`}>
                        {p.gamesInvited}
                      </td>
                      <td className="py-2 pr-3 text-center text-sm tabular-nums text-emerald-500" data-testid={`cell-in-${p.id}`}>
                        {p.rsvpCounts.in}
                      </td>
                      <td className="py-2 pr-3 text-center text-sm tabular-nums text-neutral-500" data-testid={`cell-out-${p.id}`}>
                        {p.rsvpCounts.out}
                      </td>
                      <td className="py-2 pr-3 text-center text-sm tabular-nums text-yellow-500" data-testid={`cell-maybe-${p.id}`}>
                        {p.rsvpCounts.maybe}
                      </td>
                      <td
                        className="py-2 pr-3 text-center text-xs text-muted-foreground"
                        title={p.lastRespondedAt ? new Date(p.lastRespondedAt).toLocaleString() : 'No responses yet'}
                        data-testid={`cell-last-${p.id}`}
                      >
                        {fmtRelative(p.lastRespondedAt)}
                      </td>
                    </tr>
                  ))}
                  {sorted.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="text-center text-muted-foreground py-8 text-sm"
                        data-testid="text-no-results"
                      >
                        {search
                          ? 'No dads match that search.'
                          : showInactive
                            ? 'No players on the roster yet.'
                            : 'No active players. Toggle "Show inactive" to see archived dads.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SortBtn({
  col, sortCol, sortDir, onSort, center, children,
}: {
  col: SortCol;
  sortCol: SortCol;
  sortDir: SortDir;
  onSort: (c: SortCol) => void;
  center?: boolean;
  children: React.ReactNode;
}) {
  const active = sortCol === col;
  return (
    <button
      onClick={() => onSort(col)}
      className={`flex items-center gap-1 hover:text-foreground transition-colors ${center ? 'mx-auto' : ''} ${active ? 'text-foreground' : ''}`}
      data-testid={`th-sort-${col}`}
    >
      {children}
      <ArrowUpDown className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-50'}`} />
      {active && <span className="text-[9px]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </button>
  );
}

function StatCard({
  icon, label, value, tone = 'neutral', muted = false, testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'neutral';
  muted?: boolean;
  testId?: string;
}) {
  const toneColor =
    tone === 'good' ? 'text-emerald-500'
    : tone === 'warn' ? 'text-amber-500'
    : muted ? 'text-muted-foreground/70'
    : 'text-muted-foreground';
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid={testId}>
      <div className={`flex items-center gap-1.5 text-xs ${toneColor}`}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold mt-1 tabular-nums">{value}</div>
    </div>
  );
}
