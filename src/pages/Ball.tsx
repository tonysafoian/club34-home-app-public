/**
 * Club34 Ball — premium RSVP experience
 *
 * Routes:
 *   /ball                — public landing (no token)
 *   /ball/p/:token       — personal multi-game RSVP page
 *
 * Query params:
 *   ?r=in|out            — auto-apply to first upcoming game
 *   ?g=<gameId>&r=in|out — auto-apply to specific game (used by email links)
 *
 * Design:
 *   Court-side luxury. Deep matte black with warm amber accents
 *   (basketball leather, not neon). Instrument Serif for display,
 *   Inter for body. Stagger animations, live avatar stacks, pulse
 *   on confirmation, confetti on RSVP.
 */

import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Loader2, Sparkles, Users, Zap, CalendarPlus } from 'lucide-react';
import ballLeagueLogo from '@/assets/ball/logo.jpg';

interface GameInList {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  minPlayers: number;
  notes: string | null;
  confirmedCount: number;
  myStatus: 'in' | 'out' | 'maybe' | 'pending_reconfirm' | null;
  respondedAt: string | null;
  reconfirmedAt: string | null;
  confirmedNames?: string[];
}

interface WaiverState {
  version: string;
  signed: boolean;
  signedAt: string | null;
  text: string;
}

interface MeResponse {
  player: { id: string; name: string; isHost: boolean; jerseySize?: string | null };
  waiver?: WaiverState;
  roster?: { active: number };
  games: GameInList[];
  game: { id: string; date: string; startTime: string; endTime: string; status: string } | null;
}

const JERSEY_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;
type JerseySize = (typeof JERSEY_SIZES)[number];

interface UpcomingGame {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  minPlayers: number;
  confirmedCount: number;
}

interface StateResponse {
  game: {
    id: string;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
    minPlayers: number;
    notes: string | null;
  } | null;
  games?: UpcomingGame[];
  banner?: string;
  confirmedCount?: number;
  confirmed?: { name: string; isHost: boolean }[];
  message?: string;
}

// ─── Calendar helpers ─────────────────────────────────────────────

function buildGoogleCalendarUrl(game: GameInList, token: string): string {
  const [y, m, d] = game.date.split('-');
  const [sh, sm] = game.startTime.split(':');
  const [eh, em] = game.endTime.split(':');
  const dtStart = `${y}${m}${d}T${sh}${sm}00`;
  const dtEnd = `${y}${m}${d}T${eh}${em}00`;
  const base = window.location.origin;
  const descParts = [
    'Wednesday Night Pickup Basketball at Club34.',
    game.notes ?? '',
    `RSVP page: ${base}/ball/p/${token}`,
  ].filter(Boolean);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: 'Ball at 34',
    dates: `${dtStart}/${dtEnd}`,
    ctz: 'America/Los_Angeles',
    location: 'Community Recreation Center, Court 1',
    details: descParts.join('\n'),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function icsDownloadUrl(token: string, gameId: string): string {
  return `/api/ball/ics/${token}/${gameId}`;
}

// ─── Date helpers ───────────────────────────────────────────────

function parseLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function monthDay(iso: string) {
  const d = parseLocal(iso);
  return {
    month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
    weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
    weekdayShort: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
  };
}

function daysFromNow(iso: string): string {
  const target = parseLocal(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Tonight';
  if (diff === 1) return 'Tomorrow';
  if (diff < 0) return 'Past';
  if (diff < 7) return `In ${diff} days`;
  if (diff < 14) return 'Next week';
  return `In ${diff} days`;
}

function formatTime(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0
    ? `${h12}${period.toLowerCase()}`
    : `${h12}:${String(m).padStart(2, '0')}${period.toLowerCase()}`;
}

// Deterministic color from a name
function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function initials(name: string): string {
  return name
    .split(' ')
    .map(s => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ─── Waiver fallbacks (used when backend omits the waiver field) ──
// Mirrors server/lib/waiverText.ts — only used as a safe rendering
// default when the API response is missing the waiver object (e.g.
// during a backend/frontend version skew). The backend is always
// the authoritative source; these constants are never signed against.
const FALLBACK_WAIVER_VERSION = 'v1';
const FALLBACK_WAIVER_TEXT = `Club34 Ball — Quick Waiver

Heads-up: basketball can lead to injuries. Sprained ankles, jammed fingers, pulled muscles, falls, collisions — they happen even in friendly games. By RSVPing yes, you're acknowledging that and agreeing to a few simple things:

1. I'm playing because I want to, at my own risk.
I'm in good enough health to play half-court basketball. If I'm not feeling it physically that day, I'll sit out or leave. I won't blame anyone else for injuries that happen during normal play.

2. I won't sue the organizer, their family, or other players.
I release the organizer, their household, and the other players from any claims for ordinary injuries that come from playing — whether from my own actions or someone else's during the game.

3. I'm responsible for my own medical costs.
My health insurance covers me. I'm not expecting the host or anyone else to pay if I get hurt.

4. I understand this doesn't cover gross negligence.
If someone deliberately or recklessly causes harm, this waiver doesn't apply — California law (Civil Code §1668) doesn't allow waiving that, and I'm not trying to.

5. This applies every time I play, until I inform the organizer otherwise.
I don't need to re-sign before each game. If I want to revoke this, I'll email organizer@example.com.

By tapping "I agree and RSVP," I'm electronically signing this waiver under the federal E-SIGN Act and California UETA.`;

// ─── Page ────────────────────────────────────────────────────────

export default function Ball() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const autoRsvp = searchParams.get('r');
  const autoGameId = searchParams.get('g');
  const queryClient = useQueryClient();
  const [autoApplied, setAutoApplied] = useState(false);
  const [confettiAt, setConfettiAt] = useState<number>(0);

  // Load fonts on first paint
  useEffect(() => {
    if (document.querySelector('link[data-ball-fonts]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600;700;800&display=swap';
    link.setAttribute('data-ball-fonts', '1');
    document.head.appendChild(link);
  }, []);

  const stateQuery = useQuery<StateResponse>({
    queryKey: ['ball', 'state'],
    queryFn: async () => {
      const r = await fetch('/api/ball/state');
      if (!r.ok) throw new Error('Failed to load');
      return r.json();
    },
    enabled: !token,
  });

  // Auto-redirect host to their personal page if they hit /ball (no token)
  // while signed in to Club34. Best of both worlds: privacy for the public,
  // direct access for the host.
  const hostTokenQuery = useQuery<{ hostToken: string | null }>({
    queryKey: ['ball', 'host-token-self'],
    queryFn: async () => {
      const r = await fetch('/api/ball/host-token', { credentials: 'include' });
      if (!r.ok) return { hostToken: null };
      return r.json();
    },
    enabled: !token,
    retry: false,
  });
  useEffect(() => {
    if (!token && hostTokenQuery.data?.hostToken) {
      window.location.replace(`/ball/p/${hostTokenQuery.data.hostToken}`);
    }
  }, [token, hostTokenQuery.data]);

  const meQuery = useQuery<MeResponse>({
    queryKey: ['ball', 'me', token],
    queryFn: async () => {
      const r = await fetch(`/api/ball/me/${token}`);
      if (!r.ok) throw new Error('Failed to load player');
      return r.json();
    },
    enabled: !!token,
  });

  // Inline waiver card state — when the player has not yet signed at
  // the current version, the WaiverCard renders above the games list
  // with a single "I have read and agree" checkbox. Yes / No / Maybe
  // buttons on every GameCard are disabled until the box is ticked.
  // A single click on yes/no then fires RSVP with acceptWaiver:true,
  // which atomically writes the signature and the RSVP server-side.
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [jerseySize, setJerseySize] = useState<JerseySize | null>(null);

  const rsvpMutation = useMutation({
    mutationFn: async ({
      gameId, status, acceptWaiver, jerseySize: js,
    }: { gameId: string; status: 'in' | 'out' | 'maybe'; acceptWaiver?: boolean; jerseySize?: JerseySize | null }) => {
      if (!token) throw new Error('Missing token');
      const r = await fetch('/api/ball/rsvp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, gameId, status, source: 'web', acceptWaiver, jerseySize: js ?? undefined }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 400 && body?.error === 'waiver_required') {
          throw new Error('Please tick the waiver checkbox above before RSVPing.');
        }
        throw new Error(body?.error || 'RSVP failed');
      }
      return { ...await r.json(), _meta: { status } };
    },
    onSuccess: (data: { _meta?: { status?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ['ball', 'me', token] });
      queryClient.invalidateQueries({ queryKey: ['ball', 'state'] });
      if (data?._meta?.status === 'in') {
        setConfettiAt(Date.now());
      }
    },
  });

  // GameCard onRsvp handler — if the server says the player is
  // unsigned, we attach acceptWaiver:true so the backend records the
  // signature in the same transaction as the RSVP write. The
  // WaiverCard already gates the buttons behind the checkbox, so this
  // flag only fires once the player has consented.
  const handleRsvp = useCallback((gameId: string, status: 'in' | 'out' | 'maybe') => {
    const waiver = meQuery.data?.waiver;
    const needsAccept = !!waiver && !waiver.signed;
    const hasStoredSize = !!meQuery.data?.player.jerseySize;
    const needsSize = needsAccept && !hasStoredSize;
    rsvpMutation.mutate({
      gameId,
      status,
      acceptWaiver: needsAccept ? true : undefined,
      jerseySize: needsSize ? jerseySize : undefined,
    });
  }, [meQuery.data, rsvpMutation, jerseySize]);

  useEffect(() => {
    if (
      autoRsvp && !autoApplied && token && meQuery.data && meQuery.data.games.length > 0 &&
      !meQuery.data.player.isHost && (autoRsvp === 'in' || autoRsvp === 'out')
    ) {
      // Click-through waiver: never auto-RSVP an unsigned player.
      // Auto-signing on deep-link arrival would bypass the required
      // explicit checkbox consent. The WaiverCard already rendered
      // above the games list — the user must tick it and click the
      // button themselves. Once signed, future deep links auto-RSVP
      // as before. (Issue #74 spec compliance.)
      if (!meQuery.data.waiver?.signed) {
        return;
      }
      const target = autoGameId
        ? meQuery.data.games.find(g => g.id === autoGameId)
        : meQuery.data.games[0];
      if (target) {
        setAutoApplied(true);
        handleRsvp(target.id, autoRsvp);
      }
    }
  }, [autoRsvp, autoGameId, autoApplied, token, meQuery.data, handleRsvp]);

  const isLoading = token ? meQuery.isLoading : stateQuery.isLoading;
  if (isLoading) return <LoadingScreen />;

  if (token && meQuery.isError) {
    return (
      <BallShell>
        <ErrorCard
          title="Link not recognized"
          message="This RSVP link doesn't match anyone on the roster. Reach out to Tony and he'll get you sorted."
          action={{
            label: 'Message Tony',
            href: 'mailto:organizer@example.com?subject=Wednesday%20Night%20Ball%20RSVP%20link',
            testId: 'link-message-tony',
          }}
        />
      </BallShell>
    );
  }

  if (token && meQuery.data) {
    const { player, games, waiver } = meQuery.data;
    const inCount = games.filter(g => g.myStatus === 'in').length;
    const totalConfirmed = games.reduce((s, g) => s + g.confirmedCount, 0);

    const needsWaiver = !waiver?.signed;
    // Jersey size is only offered at first sign-up (it's optional —
    // useful for pinnies/swag but never blocks RSVP). Once a size is
    // stored, don't re-prompt. Once the waiver is on file, don't
    // re-prompt either.
    const needsJerseySize = needsWaiver && !player.jerseySize;
    // RSVP is gated only on the waiver checkbox — jersey size never
    // blocks. (Spec correction from issue #92.)
    const disableCommit = needsWaiver && !waiverAccepted;
    const disableReason: string | null = disableCommit
      ? 'Tick the waiver above to RSVP'
      : null;

    return (
      <BallShell confettiAt={confettiAt}>
        <Greeting name={player.name} isHost={player.isHost} inCount={inCount} totalGames={games.length} />

        {player.isHost && <HostBadge />}

        {needsWaiver ? (
          <WaiverCard
            text={waiver?.text ?? FALLBACK_WAIVER_TEXT}
            version={waiver?.version ?? FALLBACK_WAIVER_VERSION}
            accepted={waiverAccepted}
            onAcceptedChange={setWaiverAccepted}
            needsJerseySize={needsJerseySize}
            jerseySize={jerseySize}
            onJerseySizeChange={setJerseySize}
          />
        ) : (
          <SignedWaiverLine signedAt={waiver?.signedAt ?? null} />
        )}

        {games.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-5">
            {games.map((g, i) => (
              <GameCard
                key={g.id}
                game={g}
                isHost={player.isHost}
                index={i}
                token={token!}
                onRsvp={(status) => handleRsvp(g.id, status)}
                pending={rsvpMutation.isPending && rsvpMutation.variables?.gameId === g.id}
                myName={player.name}
                disableCommit={disableCommit}
                disableReason={disableReason}
              />
            ))}
          </div>
        )}

        <SeasonStats
          totalConfirmed={totalConfirmed}
          dadsOnRoster={meQuery.data?.roster?.active ?? games[0]?.confirmedCount ?? 0}
          games={games.length}
        />
        <Footer />
      </BallShell>
    );
  }

  // Generic /ball landing
  return (
    <BallShell>
      <PublicLanding state={stateQuery.data} />
      <Footer />
    </BallShell>
  );
}

// ─── Shell ───────────────────────────────────────────────────────

function BallShell({ children, confettiAt }: { children: React.ReactNode; confettiAt?: number }) {
  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{
        background: 'radial-gradient(ellipse at top, #1a0e07 0%, #0a0706 50%, #050403 100%)',
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <BackgroundEffects />
      {confettiAt ? <Confetti seed={confettiAt} /> : null}

      <div className="relative z-10 px-5 sm:px-6 pb-14">
        <div className="max-w-md mx-auto">
          <Header />
          {children}
        </div>
      </div>
    </div>
  );
}

function BackgroundEffects() {
  return (
    <>
      {/* Top-right ambient amber glow */}
      <div
        className="pointer-events-none absolute -top-40 -right-40 w-[520px] h-[520px] rounded-full blur-3xl opacity-40"
        style={{ background: 'radial-gradient(circle, #d97706 0%, transparent 70%)' }}
      />
      {/* Bottom-left cooler counterpoint */}
      <div
        className="pointer-events-none absolute -bottom-32 -left-32 w-[420px] h-[420px] rounded-full blur-3xl opacity-20"
        style={{ background: 'radial-gradient(circle, #6b2c14 0%, transparent 70%)' }}
      />
      {/* Subtle noise / grain via SVG filter */}
      <svg className="pointer-events-none absolute inset-0 w-full h-full opacity-[0.03] mix-blend-overlay" aria-hidden>
        <filter id="ballnoise">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" />
          <feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.5 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ballnoise)" />
      </svg>
      {/* Court line vignette */}
      <div
        className="pointer-events-none absolute -bottom-72 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-[50%] opacity-[0.06]"
        style={{ border: '1px solid #f5a524' }}
      />
      <div
        className="pointer-events-none absolute -bottom-96 left-1/2 -translate-x-1/2 w-[1100px] h-[600px] rounded-[50%] opacity-[0.03]"
        style={{ border: '1px solid #f5a524' }}
      />
    </>
  );
}

function Confetti({ seed }: { seed: number }) {
  // Deterministic burst of 24 particles from the seed
  const particles = useMemo(() => {
    const out: { left: number; delay: number; dur: number; size: number; hue: number; rot: number }[] = [];
    let s = seed % 100000;
    const rand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 0; i < 24; i++) {
      out.push({
        left: rand() * 100,
        delay: rand() * 0.2,
        dur: 1.4 + rand() * 0.8,
        size: 6 + rand() * 6,
        hue: 30 + rand() * 25, // amber range
        rot: rand() * 720,
      });
    }
    return out;
  }, [seed]);

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {particles.map((p, i) => (
        <span
          key={`${seed}-${i}`}
          className="absolute top-0 block"
          style={{
            left: `${p.left}%`,
            width: `${p.size}px`,
            height: `${p.size * 0.6}px`,
            background: `hsl(${p.hue}, 95%, 60%)`,
            transform: `rotate(${p.rot}deg)`,
            animation: `confetti-fall ${p.dur}s cubic-bezier(0.4, 0, 0.6, 1) ${p.delay}s forwards`,
            opacity: 0,
            borderRadius: '2px',
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% { opacity: 1; transform: translateY(-20px) rotate(0deg); }
          100% { opacity: 0; transform: translateY(110vh) rotate(720deg); }
        }
      `}</style>
    </div>
  );
}

function Header() {
  return (
    <header className="pt-12 pb-10 text-center">
      <div className="inline-block relative mb-6">
        <img
          src={ballLeagueLogo}
          alt="Club34 Ball"
          className="w-20 h-20 rounded-full object-cover"
          style={{ boxShadow: '0 0 32px 8px rgba(245, 165, 36, 0.35)' }}
        />
        <div
          className="absolute inset-0 blur-2xl opacity-40 rounded-full"
          style={{ background: 'radial-gradient(circle, #f5a524 0%, transparent 70%)' }}
        />
      </div>
      <h1
        className="text-[3.25rem] leading-[0.95] font-bold text-white tracking-tight"
        style={{
          fontFamily: "'Instrument Serif', Georgia, serif",
          fontWeight: 400,
          letterSpacing: '-0.02em',
        }}
      >
        <span style={{ fontStyle: 'italic' }}>Club</span>
        <span style={{
          background: 'linear-gradient(180deg, #fbbf48 0%, #f5a524 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          padding: '0 6px',
        }}>34</span>
        <span style={{ fontStyle: 'italic' }}>Ball</span>
      </h1>
      <div className="mt-4 inline-flex items-center gap-3 text-[11px] uppercase tracking-[0.22em] text-neutral-500">
        <span className="w-8 h-px bg-neutral-700" />
        <span>Wednesday Pickup · 6–8pm</span>
        <span className="w-8 h-px bg-neutral-700" />
      </div>
    </header>
  );
}

// ─── Personal page sections ──────────────────────────────────────

function Greeting({
  name, isHost, inCount, totalGames,
}: { name: string; isHost: boolean; inCount: number; totalGames: number }) {
  const first = name.split(' ')[0];
  return (
    <div className="text-center mb-8">
      <p
        className="text-[1.75rem] text-white leading-tight"
        style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic' }}
      >
        Welcome, {first}.
      </p>
      <p className="text-sm text-neutral-400 mt-2.5 leading-relaxed">
        {isHost ? (
          <>You're the host. Auto-IN for all <strong className="text-amber-400">{totalGames}</strong> games.</>
        ) : inCount === 0 ? (
          <>Pick the Wednesdays you can run.</>
        ) : (
          <>Locked in for <strong className="text-amber-400">{inCount}</strong> of <strong className="text-white">{totalGames}</strong> games.</>
        )}
      </p>
    </div>
  );
}

function HostBadge() {
  return (
    <div
      className="mb-6 rounded-2xl p-5 relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, rgba(245,165,36,0.10) 0%, rgba(245,165,36,0.02) 100%)',
        border: '1px solid rgba(245,165,36,0.22)',
      }}
    >
      <div
        className="absolute -top-10 -right-10 w-32 h-32 rounded-full blur-2xl opacity-50"
        style={{ background: 'radial-gradient(circle, #f5a524 0%, transparent 70%)' }}
      />
      <div className="relative flex items-start gap-3">
        <div
          className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
          style={{
            background: 'linear-gradient(135deg, #fbbf48, #d97706)',
            boxShadow: '0 4px 12px -2px rgba(245,165,36,0.4)',
          }}
        >
          <Sparkles className="w-5 h-5" style={{ color: '#1a0e07' }} />
        </div>
        <div>
          <div className="text-sm font-bold text-white mb-0.5">Host</div>
          <p className="text-xs text-neutral-400 leading-relaxed">
            You're auto-confirmed every Wednesday. Manage other dads in the admin panel.
          </p>
        </div>
      </div>
    </div>
  );
}

function GameCard({
  game, isHost, index, token, onRsvp, pending, myName, disableCommit = false, disableReason = null,
}: {
  game: GameInList;
  isHost: boolean;
  index: number;
  token: string;
  onRsvp: (status: 'in' | 'out') => void;
  pending: boolean;
  myName: string;
  disableCommit?: boolean;
  disableReason?: string | null;
}) {
  // Buttons are disabled while a request is in flight, or — when the
  // player hasn't accepted the inline waiver yet — until the checkbox
  // above is ticked. This is what enforces the spec's "Yes/No buttons
  // disabled until checkbox is ticked" rule at the per-card level.
  const buttonsDisabled = pending || disableCommit;
  const { month, day, weekday } = monthDay(game.date);
  const distance = daysFromNow(game.date);
  const isToday = distance === 'Tonight';
  const status = game.myStatus;
  const isPending = status === 'pending_reconfirm';
  const isIn = isHost || status === 'in';
  const isOut = status === 'out';
  const onTrack = game.confirmedCount >= game.minPlayers;
  const fillPct = Math.min(100, (game.confirmedCount / Math.max(game.minPlayers, 1)) * 100);

  // Accent: green when the game has hit its minimum (highest-priority signal),
  // amber when the viewer is personally in but the game isn't on yet,
  // neutral otherwise. Kept inline (no new theme tokens) per task spec.
  const accent: 'green' | 'amber' | 'neutral' = onTrack ? 'green' : isIn ? 'amber' : 'neutral';
  const accentColors = {
    green: {
      border: '1px solid rgba(34,197,94,0.45)',
      shadow: '0 1px 0 rgba(255,255,255,0.04), 0 10px 40px -16px rgba(34,197,94,0.5)',
      bg: 'linear-gradient(180deg, #0d1a12 0%, #08110b 100%)',
      monthText: '#4ade80',
      monthBorder: 'rgba(34,197,94,0.3)',
      dayShadow: '0 0 24px rgba(34,197,94,0.35)',
      pill: '#4ade80',
      barGradient: 'linear-gradient(90deg, #86efac, #4ade80, #16a34a)',
      barGlow: '0 0 12px rgba(34,197,94,0.55)',
    },
    amber: {
      border: '1px solid rgba(245,165,36,0.35)',
      shadow: '0 1px 0 rgba(255,255,255,0.04), 0 10px 40px -16px rgba(245,165,36,0.4)',
      bg: 'linear-gradient(180deg, #1d130a 0%, #0e0907 100%)',
      monthText: '#fbbf48',
      monthBorder: 'rgba(245,165,36,0.3)',
      dayShadow: '0 0 24px rgba(245,165,36,0.3)',
      pill: '#fbbf48',
      barGradient: 'linear-gradient(90deg, #fbbf48, #f5a524, #d97706)',
      barGlow: '0 0 12px rgba(245,165,36,0.5)',
    },
    neutral: {
      border: '1px solid #2a2826',
      shadow: '0 1px 0 rgba(255,255,255,0.04), 0 4px 16px -8px rgba(0,0,0,0.5)',
      bg: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
      monthText: '#737373',
      monthBorder: '#2a2826',
      dayShadow: 'none',
      pill: '#737373',
      barGradient: 'linear-gradient(90deg, #525252, #737373)',
      barGlow: 'none',
    },
  }[accent];

  // Fake-load some avatars for visual interest (real version pulls from API later)
  const showAvatars = game.confirmedCount > 0;
  const [showRoster, setShowRoster] = useState(false);
  const rosterNames = game.confirmedNames ?? [];

  return (
    <div
      className="rounded-2xl overflow-hidden relative group"
      style={{
        background: accentColors.bg,
        border: accent === 'neutral' && isPending
          ? '1px solid rgba(234,179,8,0.3)'
          : accentColors.border,
        boxShadow: accentColors.shadow,
        animation: `slide-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) ${index * 80}ms both`,
      }}
    >
      <style>{`
        @keyframes slide-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse-amber {
          0%, 100% { box-shadow: 0 0 0 0 rgba(245,165,36,0.4); }
          50% { box-shadow: 0 0 0 8px rgba(245,165,36,0); }
        }
      `}</style>

      {/* Today badge ribbon */}
      {isToday && (
        <div
          className="absolute top-3 right-3 text-[9px] font-bold uppercase tracking-[0.15em] px-2.5 py-1 rounded-full z-10"
          style={{
            background: 'linear-gradient(135deg, #fbbf48, #d97706)',
            color: '#1a0e07',
            boxShadow: '0 2px 8px rgba(245,165,36,0.5)',
            animation: 'pulse-amber 2s ease-in-out infinite',
          }}
        >
          ⚡ Tonight
        </div>
      )}

      <div className="p-5">
        <div className="flex items-start gap-5">
          {/* Big date block — calendar tear-off */}
          <div className="shrink-0 w-[68px] text-center">
            <div
              className="text-[10px] font-bold tracking-[0.2em] pb-1 mb-1 border-b"
              style={{
                color: accentColors.monthText,
                borderColor: accentColors.monthBorder,
              }}
            >
              {month}
            </div>
            <div
              className="text-[3.25rem] font-bold text-white leading-none tracking-tighter"
              style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontWeight: 400,
                textShadow: accentColors.dayShadow,
              }}
            >
              {day}
            </div>
            <div className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mt-1 font-medium">
              {weekday.slice(0, 3)}
            </div>
          </div>

          {/* Right column */}
          <div className="flex-1 min-w-0">
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 font-semibold">
                {distance}
              </div>
              <div className="text-[15px] font-semibold text-white mt-0.5">
                {formatTime(game.startTime)}–{formatTime(game.endTime)}
              </div>
            </div>

            {/* Avatar stack + count + status */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {showAvatars && (
                    <AvatarStack
                      count={game.confirmedCount}
                      myName={isIn ? myName : undefined}
                      names={game.confirmedNames}
                    />
                  )}
                  <span className="text-base text-neutral-200 font-semibold leading-none">
                    {game.confirmedCount} in
                    <span className="text-neutral-500 font-normal text-sm"> · need {game.minPlayers}</span>
                  </span>
                </div>
                {onTrack ? (
                  <span
                    className="text-[10px] uppercase tracking-[0.15em] font-bold flex items-center gap-1 shrink-0"
                    style={{ color: accentColors.pill }}
                  >
                    <Zap className="w-3 h-3 fill-current" />
                    Game on
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-[0.15em] text-neutral-600 shrink-0">
                    {game.minPlayers - game.confirmedCount} more
                  </span>
                )}
              </div>
              {/* Progress bar */}
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#1a1614' }}>
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: `${fillPct}%`,
                    background: accentColors.barGradient,
                    boxShadow: accentColors.barGlow,
                  }}
                />
              </div>

              {/* Who's in — expandable roster of confirmed dads. The
                  avatar tiles above only fit 4 initials, so this is
                  the answer to "who are the TWO RSVPs?" without
                  needing to open admin. Only renders when we actually
                  know names (server provides confirmedNames[]). */}
              {showAvatars && rosterNames.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowRoster(v => !v)}
                    data-testid={`button-toggle-roster-${game.id}`}
                    className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 hover:text-amber-400 transition-colors font-semibold flex items-center gap-1"
                    aria-expanded={showRoster}
                  >
                    <span>{showRoster ? 'Hide' : 'Show'} who's in</span>
                    <span
                      className="inline-block transition-transform"
                      style={{ transform: showRoster ? 'rotate(180deg)' : 'rotate(0deg)' }}
                      aria-hidden
                    >
                      ▾
                    </span>
                  </button>
                  {showRoster && (
                    <ul
                      data-testid={`list-roster-${game.id}`}
                      className="mt-2 space-y-1.5 pl-0.5"
                    >
                      {rosterNames.map((n, i) => {
                        const isMe = !!myName && n === myName;
                        const hue = avatarHue(n);
                        return (
                          <li
                            key={`${n}-${i}`}
                            className="flex items-center gap-2 text-[12px]"
                            data-testid={`text-roster-name-${game.id}-${i}`}
                          >
                            <span
                              className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0"
                              style={{
                                background: isMe
                                  ? 'linear-gradient(135deg, #fbbf48, #d97706)'
                                  : `hsl(${hue}, 30%, 22%)`,
                                color: isMe ? '#1a0e07' : `hsl(${hue}, 50%, 70%)`,
                              }}
                            >
                              {initials(n)}
                            </span>
                            <span className={isMe ? 'text-amber-400 font-medium' : 'text-neutral-300'}>
                              {n}{isMe && <span className="text-neutral-500 font-normal"> · you</span>}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Action area */}
            {isHost ? (
              <HostInCallout game={game} token={token} />
            ) : isPending ? (
              <ReconfirmActions onRsvp={onRsvp} pending={buttonsDisabled} loading={pending} />
            ) : isIn ? (
              <ConfirmedActions game={game} token={token} onRsvp={onRsvp} pending={buttonsDisabled} />
            ) : isOut ? (
              <OutActions onRsvp={onRsvp} pending={buttonsDisabled} loading={pending} />
            ) : (
              <FreshActions onRsvp={onRsvp} pending={buttonsDisabled} loading={pending} />
            )}
            {disableCommit && !isHost && (
              <p
                className="mt-2 text-[10px] uppercase tracking-[0.16em] text-amber-500/70 font-semibold"
                data-testid={`text-waiver-prompt-${game.id}`}
              >
                {disableReason ?? 'Tick the waiver above to RSVP'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AvatarStack({ count, myName, names }: { count: number; myName?: string; names?: string[] }) {
  // Show up to 4 real avatars. When the backend provides the
  // confirmed names list (preferred), use real initials; "me" is
  // always pinned first when I'm in. Fall back to "··" placeholders
  // only if names are unavailable (e.g. old API version).
  const display = Math.min(count, 4);
  const tiles: { initials: string; hue: number; isMe: boolean }[] = [];
  if (myName) {
    tiles.push({ initials: initials(myName), hue: avatarHue(myName), isMe: true });
  }
  const others = (names ?? []).filter(n => !myName || n !== myName);
  for (const name of others) {
    if (tiles.length >= display) break;
    tiles.push({ initials: initials(name), hue: avatarHue(name), isMe: false });
  }
  for (let i = tiles.length; i < display; i++) {
    const hue = (i * 67 + 40) % 360;
    tiles.push({ initials: '··', hue, isMe: false });
  }
  return (
    <div className="flex -space-x-1.5">
      {tiles.map((t, i) => (
        <div
          key={i}
          className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold border-2"
          style={{
            background: t.isMe
              ? 'linear-gradient(135deg, #fbbf48, #d97706)'
              : `hsl(${t.hue}, 30%, 22%)`,
            borderColor: '#0e0907',
            color: t.isMe ? '#1a0e07' : `hsl(${t.hue}, 50%, 70%)`,
            zIndex: tiles.length - i,
          }}
        >
          {t.initials}
        </div>
      ))}
      {count > display && (
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold border-2"
          style={{
            background: '#1a1614',
            borderColor: '#0e0907',
            color: '#737373',
            zIndex: 0,
          }}
        >
          +{count - display}
        </div>
      )}
    </div>
  );
}

function HostInCallout({ game, token }: { game: GameInList; token: string }) {
  return (
    <div>
      <div className="text-xs font-semibold flex items-center gap-1.5 mb-3" style={{ color: '#fbbf48' }}>
        <Check className="w-3.5 h-3.5" /> Auto-confirmed
      </div>
      <AddToCalendar game={game} token={token} />
    </div>
  );
}

function ReconfirmActions({ onRsvp, pending, loading }: { onRsvp: (s: 'in' | 'out') => void; pending: boolean; loading: boolean }) {
  return (
    <>
      <div className="text-[11px] mb-3 text-yellow-300/90 leading-snug font-medium">
        Tap to re-confirm. Spots drop at 11am.
      </div>
      <div className="flex gap-2">
        <PrimaryButton onClick={() => onRsvp('in')} disabled={pending}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Yes, playing'}
        </PrimaryButton>
        <SecondaryButton onClick={() => onRsvp('out')} disabled={pending}>Out</SecondaryButton>
      </div>
    </>
  );
}

function ConfirmedActions({ game, token, onRsvp, pending }: {
  game: GameInList;
  token: string;
  onRsvp: (s: 'in' | 'out') => void;
  pending: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <div
          className="flex-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider"
          style={{ color: '#fbbf48' }}
        >
          <Check className="w-4 h-4" /> You're in
        </div>
        <button
          onClick={() => onRsvp('out')}
          disabled={pending}
          className="text-[11px] text-neutral-500 hover:text-neutral-300 transition-colors px-2.5 py-1 rounded"
        >
          Change
        </button>
      </div>
      <AddToCalendar game={game} token={token} />
    </div>
  );
}

function AddToCalendar({ game, token }: { game: GameInList; token: string }) {
  const googleUrl = buildGoogleCalendarUrl(game, token);
  const icsUrl = icsDownloadUrl(token, game.id);
  return (
    <div
      className="flex items-center gap-2 flex-wrap"
      data-testid={`add-to-calendar-${game.id}`}
    >
      <a
        href={googleUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`calendar-google-${game.id}`}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
        style={{
          background: 'rgba(26,115,232,0.15)',
          color: '#93c5fd',
          border: '1px solid rgba(26,115,232,0.25)',
        }}
      >
        <CalendarPlus className="w-3 h-3" />
        Google Cal
      </a>
      <a
        href={icsUrl}
        download={`ball-${game.date}.ics`}
        data-testid={`calendar-apple-${game.id}`}
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
        style={{
          background: 'rgba(255,255,255,0.06)',
          color: '#a3a3a3',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <CalendarPlus className="w-3 h-3" />
        Apple (.ics)
      </a>
    </div>
  );
}

function OutActions({ onRsvp, pending, loading }: { onRsvp: (s: 'in' | 'out') => void; pending: boolean; loading: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 flex items-center gap-1.5 text-xs text-neutral-500 font-medium">
        <X className="w-4 h-4" /> Not this one
      </div>
      <PrimaryButton onClick={() => onRsvp('in')} disabled={pending} small>
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "I'm in"}
      </PrimaryButton>
    </div>
  );
}

function FreshActions({ onRsvp, pending, loading }: { onRsvp: (s: 'in' | 'out') => void; pending: boolean; loading: boolean }) {
  return (
    <div className="flex gap-2">
      <PrimaryButton onClick={() => onRsvp('in')} disabled={pending}>
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "I'm in"}
      </PrimaryButton>
      <SecondaryButton onClick={() => onRsvp('out')} disabled={pending}>Can't make it</SecondaryButton>
    </div>
  );
}

function PrimaryButton({
  children, onClick, disabled, small,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 ${small ? 'h-9 text-xs' : 'h-12 text-sm'} rounded-xl font-bold transition-all active:scale-[0.96] disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden`}
      style={{
        background: 'linear-gradient(180deg, #fcd34d 0%, #fbbf48 35%, #f5a524 100%)',
        color: '#1c0f04',
        boxShadow: '0 1px 0 rgba(255,255,255,0.4) inset, 0 0 0 1px rgba(180,90,12,0.4), 0 6px 16px -4px rgba(245,165,36,0.5)',
        textShadow: '0 1px 0 rgba(255,255,255,0.15)',
        letterSpacing: '0.01em',
      }}
    >
      <span className="relative z-10">{children}</span>
      {/* shine overlay */}
      <span
        className="absolute inset-0 opacity-0 group-hover:opacity-100 pointer-events-none"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, transparent 50%)' }}
      />
    </button>
  );
}

function SecondaryButton({
  children, onClick, disabled,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 h-12 rounded-xl font-semibold text-sm text-neutral-300 transition-all active:scale-[0.96] disabled:opacity-50"
      style={{
        background: 'linear-gradient(180deg, #221d18 0%, #181513 100%)',
        border: '1px solid #2e2a26',
      }}
    >
      {children}
    </button>
  );
}

function SeasonStats({ totalConfirmed, dadsOnRoster, games }: { totalConfirmed: number; dadsOnRoster: number; games: number }) {
  return (
    <div className="mt-8 grid grid-cols-3 gap-3">
      <StatTile value={dadsOnRoster} label="Dads on Roster" />
      <StatTile value={games} label="games" />
      <StatTile value={totalConfirmed} label="RSVPs so far" highlight />
    </div>
  );
}

function StatTile({ value, label, highlight }: { value: number; label: string; highlight?: boolean }) {
  return (
    <div
      className="rounded-xl p-3 text-center"
      style={{
        background: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
        border: '1px solid #2a2826',
      }}
    >
      <div
        className="text-2xl font-bold leading-none"
        style={{
          fontFamily: "'Instrument Serif', Georgia, serif",
          fontWeight: 400,
          color: highlight ? '#fbbf48' : 'white',
        }}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500 mt-1 font-semibold">
        {label}
      </div>
    </div>
  );
}

// ─── Generic landing ────────────────────────────────────────────

function PublicLanding({ state }: { state: StateResponse | undefined }) {
  const game = state?.game;

  if (!game) {
    return <ErrorCard title="No games scheduled" message="Wednesday Night Ball will return. Check back soon." />;
  }

  // Every upcoming game beyond the soonest one (which keeps the hero treatment).
  const moreGames = (state?.games ?? []).slice(1);

  const { month, day, weekday } = monthDay(game.date);
  const onTrack = (state?.confirmedCount ?? 0) >= game.minPlayers;

  // Mirror GameCard's accent palette so the public/share preview turns
  // green once the game has hit its minimum. The public viewer has no
  // personal "in" state, so the off-track default is neutral (matching
  // the task spec: amber is reserved for "viewer is in but game not on").
  const accent: 'green' | 'neutral' = onTrack ? 'green' : 'neutral';
  const accentColors = {
    green: {
      bg: 'linear-gradient(180deg, #0d1a12 0%, #08110b 100%)',
      border: '1px solid rgba(34,197,94,0.45)',
      shadow: '0 1px 0 rgba(255,255,255,0.04), 0 10px 40px -16px rgba(34,197,94,0.5)',
      glowRadial: 'radial-gradient(circle, #22c55e 0%, transparent 70%)',
      labelText: 'text-emerald-400/80',
      monthText: '#4ade80',
      monthBorder: 'rgba(34,197,94,0.3)',
      dayShadow: '0 0 24px rgba(34,197,94,0.35)',
      bannerBg: 'rgba(34,197,94,0.10)',
      bannerText: '#4ade80',
      bannerBorder: 'rgba(34,197,94,0.25)',
    },
    neutral: {
      bg: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
      border: '1px solid #2a2826',
      shadow: '0 1px 0 rgba(255,255,255,0.04), 0 4px 16px -8px rgba(0,0,0,0.5)',
      glowRadial: 'radial-gradient(circle, #525252 0%, transparent 70%)',
      labelText: 'text-neutral-500',
      monthText: '#a3a3a3',
      monthBorder: '#2a2826',
      dayShadow: 'none',
      bannerBg: 'rgba(115,115,115,0.06)',
      bannerText: '#a3a3a3',
      bannerBorder: 'rgba(115,115,115,0.15)',
    },
  }[accent];

  return (
    <>
      <div
        className="rounded-2xl p-6 mb-4 relative overflow-hidden"
        style={{
          background: accentColors.bg,
          border: accentColors.border,
          boxShadow: accentColors.shadow,
        }}
      >
        <div
          className="absolute -top-20 -right-20 w-48 h-48 rounded-full blur-3xl opacity-40"
          style={{ background: accentColors.glowRadial }}
        />
        <div className="relative">
          <div className={`text-[10px] uppercase tracking-[0.2em] ${accentColors.labelText} font-bold mb-3 flex items-center gap-2`}>
            <span>Next Game</span>
            {onTrack && (
              <span
                className="text-[10px] uppercase tracking-[0.15em] font-bold flex items-center gap-1"
                style={{ color: accentColors.monthText }}
              >
                <Zap className="w-3 h-3 fill-current" />
                Game on
              </span>
            )}
          </div>
          <div className="flex items-start gap-5 mb-5">
            <div className="shrink-0 w-[68px] text-center">
              <div
                className="text-[10px] font-bold tracking-[0.2em] pb-1 mb-1 border-b"
                style={{ color: accentColors.monthText, borderColor: accentColors.monthBorder }}
              >
                {month}
              </div>
              <div
                className="text-[3.25rem] font-bold text-white leading-none tracking-tighter"
                style={{
                  fontFamily: "'Instrument Serif', Georgia, serif",
                  fontWeight: 400,
                  textShadow: accentColors.dayShadow,
                }}
              >
                {day}
              </div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-neutral-500 mt-1 font-medium">
                {weekday.slice(0, 3)}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 font-semibold">
                {daysFromNow(game.date)}
              </div>
              <div className="text-[15px] font-semibold text-white mt-0.5">
                {formatTime(game.startTime)}–{formatTime(game.endTime)}
              </div>
            </div>
          </div>

          <div
            className="rounded-xl px-4 py-3 text-sm font-semibold"
            style={{
              background: accentColors.bannerBg,
              color: accentColors.bannerText,
              border: `1px solid ${accentColors.bannerBorder}`,
            }}
          >
            {state?.banner ?? `${state?.confirmedCount ?? 0} in so far`}
          </div>
        </div>
      </div>

      {moreGames.length > 0 && (
        <div className="mb-4" data-testid="section-more-games">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-bold mb-2 px-1">
            More upcoming
          </div>
          <div className="flex flex-col gap-2">
            {moreGames.map((g) => {
              const md = monthDay(g.date);
              const on = g.confirmedCount >= g.minPlayers;
              return (
                <div
                  key={g.id}
                  data-testid={`row-upcoming-game-${g.id}`}
                  className="flex items-center gap-4 rounded-xl px-4 py-3"
                  style={{
                    background: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
                    border: '1px solid #2a2826',
                  }}
                >
                  <div className="shrink-0 w-11 text-center">
                    <div className="text-[9px] font-bold tracking-[0.15em] text-neutral-500">
                      {md.month}
                    </div>
                    <div
                      className="text-2xl font-bold text-white leading-none"
                      style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400 }}
                    >
                      {md.day}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white">{md.weekday}</div>
                    <div className="text-xs text-neutral-500">
                      {formatTime(g.startTime)}–{formatTime(g.endTime)}
                    </div>
                  </div>
                  <div
                    className={`shrink-0 text-sm font-semibold ${on ? 'text-emerald-400' : 'text-neutral-400'}`}
                    data-testid={`text-upcoming-count-${g.id}`}
                  >
                    {g.confirmedCount} in
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div
        className="rounded-2xl p-6 text-center"
        style={{
          background: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
          border: '1px solid #2a2826',
        }}
      >
        <Users className="w-5 h-5 mx-auto mb-3 text-neutral-500" />
        <p className="text-sm text-neutral-400 leading-relaxed">
          Pickup is by personal invite. Check your email for your RSVP link, or ping Tony.
        </p>
      </div>
    </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="rounded-2xl p-10 text-center"
      style={{
        background: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
        border: '1px solid #2a2826',
      }}
    >
      <img src={ballLeagueLogo} alt="Club34 Ball" className="w-14 h-14 mx-auto mb-4 opacity-40 rounded-full object-cover" />
      <h2
        className="text-xl text-white mb-2"
        style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic' }}
      >
        No games on the schedule
      </h2>
      <p className="text-sm text-neutral-500">Wednesday Night Ball will return. Check back soon.</p>
    </div>
  );
}

function ErrorCard({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; href: string; testId?: string };
}) {
  return (
    <div
      className="rounded-2xl p-10 text-center"
      style={{
        background: 'linear-gradient(180deg, #14110f 0%, #0d0b09 100%)',
        border: '1px solid #2a2826',
      }}
    >
      <img src={ballLeagueLogo} alt="Club34 Ball" className="w-14 h-14 mx-auto mb-4 opacity-40 rounded-full object-cover" />
      <h1
        className="text-2xl text-white mb-2"
        style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic' }}
      >
        {title}
      </h1>
      <p className="text-sm text-neutral-500 leading-relaxed">{message}</p>
      {action && (
        <a
          href={action.href}
          data-testid={action.testId}
          className="inline-flex items-center justify-center mt-6 px-5 py-2.5 rounded-full text-sm text-white transition-colors"
          style={{
            background: 'linear-gradient(180deg, #2a2826 0%, #1a1816 100%)',
            border: '1px solid #3a3836',
          }}
        >
          {action.label}
        </a>
      )}
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#0a0706' }}>
      <Loader2 className="w-12 h-12 animate-spin text-neutral-500" />
    </div>
  );
}

// ─── Inline Liability Waiver Card ────────────────────────────────
//
// Per spec: renders above the RSVP buttons (not as a modal). Single
// checkbox "I have read and agree to the above." gates every Yes/No
// button on every GameCard until checked. After a single click on
// yes/no, the RSVP fires with acceptWaiver:true and the backend
// records IP + User-Agent + timestamp into ball_waivers atomically.

function WaiverCard({
  text, version, accepted, onAcceptedChange,
  needsJerseySize, jerseySize, onJerseySizeChange,
}: {
  text: string;
  version: string;
  accepted: boolean;
  onAcceptedChange: (v: boolean) => void;
  needsJerseySize: boolean;
  jerseySize: JerseySize | null;
  onJerseySizeChange: (v: JerseySize) => void;
}) {
  return (
    <div
      data-testid="waiver-card"
      className="mb-6 rounded-2xl overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #1d130a 0%, #0e0907 100%)',
        border: '1px solid rgba(245,165,36,0.35)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.04), 0 10px 30px -16px rgba(245,165,36,0.3)',
      }}
    >
      <div className="px-5 pt-5 pb-3 border-b" style={{ borderColor: 'rgba(245,165,36,0.18)' }}>
        <div className="text-[10px] uppercase tracking-[0.2em] text-amber-500/70 font-bold mb-1">
          Quick one-time step · {version}
        </div>
        <h2
          className="text-xl text-white"
          style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontStyle: 'italic' }}
        >
          Before you RSVP
        </h2>
      </div>

      <div
        data-testid="waiver-text"
        className="px-5 py-4 overflow-y-auto text-[13px] leading-relaxed text-neutral-300 whitespace-pre-wrap"
        style={{ maxHeight: '280px' }}
      >
        {text}
      </div>

      {needsJerseySize && (
        <div className="px-5 pt-4 pb-1 border-t" style={{ borderColor: 'rgba(245,165,36,0.18)' }}>
          <div className="text-[10px] uppercase tracking-[0.18em] text-amber-500/80 font-bold mb-2">
            Jersey size (optional)
          </div>
          <p className="text-[12px] text-neutral-400 leading-snug mb-3">
            For pinnies and team swag. Pick what fits — totally optional, won't block your RSVP.
          </p>
          <div
            role="radiogroup"
            aria-label="Jersey size"
            data-testid="group-jersey-size"
            className="flex flex-wrap gap-2"
          >
            {JERSEY_SIZES.map((s) => {
              const selected = jerseySize === s;
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-testid={`button-jersey-size-${s}`}
                  onClick={() => onJerseySizeChange(s)}
                  className="px-3.5 py-2 rounded-lg text-[12px] font-bold tracking-wider transition-all border"
                  style={{
                    background: selected
                      ? 'linear-gradient(135deg, #fbbf48, #d97706)'
                      : '#14110f',
                    borderColor: selected ? 'rgba(245,165,36,0.9)' : '#2a2826',
                    color: selected ? '#1a0e07' : '#a3a3a3',
                    boxShadow: selected
                      ? '0 4px 14px -4px rgba(245,165,36,0.55)'
                      : 'none',
                  }}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-5 py-4 border-t" style={{ borderColor: 'rgba(245,165,36,0.18)' }}>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => onAcceptedChange(e.target.checked)}
            data-testid="checkbox-waiver-agree"
            className="mt-0.5 w-4 h-4 accent-amber-500 cursor-pointer"
          />
          <span className="text-[12px] text-neutral-300 leading-snug">
            I have read and agree to the above. I'm signing electronically.
          </span>
        </label>
      </div>
    </div>
  );
}

function SignedWaiverLine({ signedAt }: { signedAt: string | null }) {
  if (!signedAt) return null;
  const date = new Date(signedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return (
    <p
      data-testid="text-waiver-signed"
      className="mb-5 text-center text-[11px] uppercase tracking-[0.18em] text-neutral-500 font-medium flex items-center justify-center gap-2"
    >
      <Check className="w-3 h-3 text-amber-500/80" />
      Waiver signed {date}
    </p>
  );
}

function Footer() {
  return (
    <footer className="text-center pt-10 pb-2">
      <div className="inline-flex items-center gap-2.5 text-[10px] uppercase tracking-[0.2em] text-neutral-700 font-semibold">
        <span>Half-court</span>
        <span className="w-1 h-1 rounded-full bg-neutral-800" />
        <span>Winners stay</span>
        <span className="w-1 h-1 rounded-full bg-neutral-800" />
        <span>4 to play</span>
      </div>
    </footer>
  );
}
