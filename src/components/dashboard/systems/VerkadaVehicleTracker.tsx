import { useState, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import {
  useVehicleProfiles,
  useVehicleSightings,
  useCreateVehicleProfile,
  useUpdateVehicleProfile,
  useDeleteVehicleProfile,
  useVerkadaConnectionStatus,
} from '@/hooks/useVerkada';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Car,
  Clock,
  Camera,
  ArrowDownToLine,
  RefreshCw,
  Plus,
  Pencil,
  Trash2,
  Check,
  X,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Search,
  Link,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import type { VehicleProfile } from '@/lib/api/verkada';

function VehicleThumbnail({ imageUrl, plate, size = 'sm' }: { imageUrl: string | null; plate: string; size?: 'sm' | 'md' }) {
  const [imgError, setImgError] = useState(false);
  const dim = size === 'md' ? 'h-10 w-14' : 'h-7 w-10';

  if (imageUrl && !imgError) {
    return (
      <img
        src={imageUrl}
        alt={`Vehicle ${plate}`}
        className={`${dim} rounded object-cover shrink-0 border border-border/50`}
        onError={() => setImgError(true)}
      />
    );
  }
  return (
    <div className={`${dim} rounded bg-primary/10 flex items-center justify-center shrink-0 border border-border/50`}>
      <Car className={`${size === 'md' ? 'h-5 w-5' : 'h-3.5 w-3.5'} text-primary/60`} />
    </div>
  );
}

function VehicleProfileRow({
  profile,
  sightingsByPlate,
}: {
  profile: VehicleProfile;
  sightingsByPlate: Map<string, { sightings_today: number; last_seen_at: string; last_seen_camera: string | null; image_url: string | null }>;
}) {
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(profile.label ?? '');
  const updateMutation = useUpdateVehicleProfile();
  const deleteMutation = useDeleteVehicleProfile();

  const sighting = sightingsByPlate.get(profile.plate.toUpperCase());

  const handleSave = async () => {
    await updateMutation.mutateAsync({ id: profile.id, label: editLabel });
    setEditing(false);
  };

  const handleCancel = () => {
    setEditLabel(profile.label ?? '');
    setEditing(false);
  };

  const todayCount = sighting?.sightings_today ?? 0;
  const lastSeenAt = sighting?.last_seen_at ?? profile.last_seen_at;
  const lastSeenCamera = sighting?.last_seen_camera ?? profile.last_seen_camera;
  const imageUrl = sighting?.image_url ?? null;

  return (
    <div
      className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
      data-testid={`vehicle-profile-${profile.id}`}
    >
      <VehicleThumbnail imageUrl={imageUrl} plate={profile.plate} size="sm" />
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              placeholder="Label (e.g. Jesse's Model X)"
              className="h-7 text-sm"
              autoFocus
              data-testid={`input-label-${profile.id}`}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-green-600"
              onClick={handleSave}
              disabled={updateMutation.isPending}
              data-testid={`button-save-${profile.id}`}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground"
              onClick={handleCancel}
              data-testid={`button-cancel-${profile.id}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm font-medium truncate">
              {profile.label || <span className="text-muted-foreground italic">No label</span>}
            </p>
            <p className="text-xs text-muted-foreground font-mono">{profile.plate}</p>
          </>
        )}
        {!editing && (
          <p className="text-xs text-muted-foreground">
            {lastSeenAt
              ? `Last: ${lastSeenCamera || 'Unknown'} at ${format(new Date(lastSeenAt), 'h:mm a')}`
              : 'Never seen today'}
          </p>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant={todayCount > 0 ? 'default' : 'outline'} className="text-xs" data-testid={`badge-sightings-${profile.id}`}>
            {todayCount} today
          </Badge>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => { setEditing(true); setEditLabel(profile.label ?? ''); }}
            data-testid={`button-edit-${profile.id}`}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => deleteMutation.mutate(profile.id)}
            disabled={deleteMutation.isPending}
            data-testid={`button-delete-${profile.id}`}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

function AddVehicleForm({ onDone }: { onDone: () => void }) {
  const [plate, setPlate] = useState('');
  const [label, setLabel] = useState('');
  const createMutation = useCreateVehicleProfile();

  const handleSubmit = async () => {
    if (!plate.trim()) return;
    await createMutation.mutateAsync({ plate: plate.trim().toUpperCase(), label: label.trim() || undefined });
    setPlate('');
    setLabel('');
    onDone();
  };

  return (
    <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/20">
      <p className="text-xs font-medium text-muted-foreground">Add Known Vehicle</p>
      <div className="flex gap-2">
        <Input
          value={plate}
          onChange={(e) => setPlate(e.target.value.toUpperCase())}
          placeholder="Plate (e.g. ABC1234)"
          className="h-8 text-sm font-mono uppercase"
          data-testid="input-new-plate"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onDone(); }}
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="h-8 text-sm"
          data-testid="input-new-label"
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onDone(); }}
        />
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onDone} className="h-7 text-xs" data-testid="button-cancel-add">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!plate.trim() || createMutation.isPending}
          className="h-7 text-xs"
          data-testid="button-submit-add"
        >
          Add Vehicle
        </Button>
      </div>
    </div>
  );
}

function formatLastSeen(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const laTime = date.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
  const toDateKey = (d: Date) => d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' });
  const eventKey = toDateKey(date);
  const todayKey = toDateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = toDateKey(yesterday);
  if (eventKey === todayKey) return `today at ${laTime}`;
  if (eventKey === yesterdayKey) return `yesterday at ${laTime}`;
  const laDate = date.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
  return `${laDate} at ${laTime}`;
}

function DiagnosticsPanel() {
  const { data: status, isLoading } = useVerkadaConnectionStatus();

  if (isLoading) {
    return <Skeleton className="h-32 rounded-lg" />;
  }

  if (!status) return null;

  const allConfigured = status.api_key_configured && status.org_id_configured;
  const hasEverReceivedData = status.total_webhook_events > 0;
  const hasLprData = status.total_lpr_events > 0;

  if (hasLprData) {
    return (
      <div
        className="rounded-lg border border-border bg-muted/30 p-4 space-y-1"
        data-testid="diagnostics-panel"
      >
        <p className="text-sm text-foreground font-medium">No vehicles seen yet today</p>
        {status.last_lpr_event_at && (
          <p className="text-xs text-muted-foreground" data-testid="status-last-seen">
            Last seen {formatLastSeen(status.last_lpr_event_at)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      data-testid="diagnostics-panel"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
        <p className="text-sm font-medium text-foreground">No license plate data today</p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Connection Status</p>
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs" data-testid="status-api-key">
            {status.api_key_configured
              ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
              : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <span className={status.api_key_configured ? 'text-foreground' : 'text-destructive'}>
              Verkada API Key {status.api_key_configured ? 'configured' : 'not configured'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs" data-testid="status-org-id">
            {status.org_id_configured
              ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
              : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />}
            <span className={status.org_id_configured ? 'text-foreground' : 'text-destructive'}>
              Verkada Org ID {status.org_id_configured ? 'configured' : 'not configured'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs" data-testid="status-webhooks">
            {hasEverReceivedData
              ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
              : <XCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
            <span className={hasEverReceivedData ? 'text-foreground' : 'text-amber-600 dark:text-amber-400'}>
              {hasEverReceivedData
                ? `Webhooks received (${status.total_webhook_events} total events)`
                : 'No webhooks received yet'}
            </span>
          </div>
          {hasEverReceivedData && !hasLprData && (
            <div className="flex items-center gap-2 text-xs" data-testid="status-lpr">
              <XCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              <span className="text-amber-600 dark:text-amber-400">
                Webhooks received but no LPR events — check LPR camera configuration
              </span>
            </div>
          )}
        </div>
      </div>

      {status.last_any_event_at && (
        <p className="text-xs text-muted-foreground" data-testid="status-last-event">
          Last event: {formatDistanceToNow(new Date(status.last_any_event_at), { addSuffix: true })}
        </p>
      )}

      {status.last_webhook_received_at && (
        <p className="text-xs text-muted-foreground" data-testid="status-last-webhook">
          Last webhook (this session): {formatDistanceToNow(new Date(status.last_webhook_received_at), { addSuffix: true })}
        </p>
      )}

      {allConfigured && status.webhook_url && (
        <div className="space-y-1.5 pt-1 border-t border-border/50">
          <p className="text-xs font-medium text-muted-foreground">Setup Instructions</p>
          <p className="text-xs text-muted-foreground">
            In Verkada Command, add a webhook pointing to this URL for LPR events:
          </p>
          <div className="flex items-center gap-2 rounded bg-muted px-2.5 py-1.5">
            <Link className="h-3 w-3 text-muted-foreground shrink-0" />
            <code className="text-xs font-mono text-foreground break-all" data-testid="text-webhook-url">
              {status.webhook_url}
            </code>
          </div>
          <p className="text-xs text-muted-foreground">
            Enable the <strong>License Plate Recognition</strong> event type in the webhook configuration.
          </p>
        </div>
      )}

      {!allConfigured && (
        <div className="pt-1 border-t border-border/50">
          <p className="text-xs text-muted-foreground">
            Contact your administrator to configure <code className="font-mono">VERKADA_API_KEY</code> and <code className="font-mono">VERKADA_ORG_ID</code> environment variables.
          </p>
        </div>
      )}
    </div>
  );
}

export function VerkadaVehicleTracker() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [plateSearch, setPlateSearch] = useState('');

  const now = useMemo(() => new Date(), []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['vehicle-profiles'] });
    await queryClient.invalidateQueries({ queryKey: ['vehicle-sightings'] });
    await queryClient.invalidateQueries({ queryKey: ['verkada-connection-status'] });
    setLastUpdated(new Date());
    setIsRefreshing(false);
  };

  const { data: profilesData, isLoading: profilesLoading } = useVehicleProfiles();
  const { data: sightingsData, isLoading: sightingsLoading } = useVehicleSightings();

  const handleVehicleEvent = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['vehicle-sightings'] });
    queryClient.invalidateQueries({ queryKey: ['vehicle-profiles'] });
    setLastUpdated(new Date());
  }, [queryClient]);
  useSocketEvent('verkada:vehicle', handleVehicleEvent);

  const isLoading = profilesLoading || sightingsLoading;

  const sightingsByPlate = useMemo(() => {
    const map = new Map<string, { sightings_today: number; last_seen_at: string; last_seen_camera: string | null; image_url: string | null }>();
    for (const s of sightingsData?.by_plate ?? []) {
      map.set(s.plate.toUpperCase(), s);
    }
    return map;
  }, [sightingsData]);

  const profiles = profilesData?.profiles ?? [];
  const recentSightings = sightingsData?.recent_sightings ?? [];
  const timelineLimit = timelineExpanded ? 50 : 15;

  const uniquePlates = sightingsData?.unique_plates ?? 0;
  const totalSightings = sightingsData?.total_sightings ?? 0;
  const camerasWithLpr = sightingsData?.cameras_with_lpr ?? 0;

  const filteredByPlate = useMemo(() => {
    const all = sightingsData?.by_plate ?? [];
    if (!plateSearch.trim()) return all;
    const search = plateSearch.trim().toUpperCase();
    return all.filter(s => s.plate.toUpperCase().includes(search));
  }, [sightingsData?.by_plate, plateSearch]);

  const hasNoData = totalSightings === 0 && !isLoading;

  return (
    <Card className="border-border bg-card" data-testid="vehicle-tracker-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Car className="h-4 w-4 text-primary" />
            Car Tracker
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {format(lastUpdated, 'h:mm a')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh data"
              data-testid="button-refresh-vehicle-tracker"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Badge variant="outline" className="text-xs">
              {format(now, 'MMM d, yyyy')}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          License plate-recognized vehicles across all LPR cameras
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground" data-testid="text-unique-plates">{uniquePlates}</span>
                <span className="text-[10px] text-muted-foreground font-medium">Unique Plates</span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground" data-testid="text-total-sightings">{totalSightings}</span>
                <span className="text-[10px] text-muted-foreground font-medium">Total Sightings</span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground" data-testid="text-cameras-lpr">{camerasWithLpr}</span>
                <span className="text-[10px] text-muted-foreground font-medium">Cameras w/ LPR</span>
              </div>
            </div>

            {hasNoData && <DiagnosticsPanel />}

            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs text-muted-foreground font-medium">Known Vehicles</p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs gap-1"
                  onClick={() => setShowAddForm((v) => !v)}
                  data-testid="button-add-vehicle"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </Button>
              </div>

              {showAddForm && (
                <AddVehicleForm onDone={() => setShowAddForm(false)} />
              )}

              {profiles.length === 0 && !showAddForm ? (
                <div className="text-center py-4 space-y-1">
                  <Car className="h-7 w-7 text-muted-foreground mx-auto" />
                  <p className="text-sm text-muted-foreground">No known vehicles tagged yet.</p>
                  <p className="text-xs text-muted-foreground">Add plates to track family vehicles.</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {profiles.map((profile) => (
                    <VehicleProfileRow
                      key={profile.id}
                      profile={profile}
                      sightingsByPlate={sightingsByPlate}
                    />
                  ))}
                </div>
              )}
            </div>

            {sightingsData && sightingsData.by_plate.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 px-1">
                  <Camera className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground font-medium flex-1">
                    All Detected Plates Today ({sightingsData.by_plate.length})
                  </p>
                </div>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={plateSearch}
                    onChange={(e) => setPlateSearch(e.target.value)}
                    placeholder="Filter by plate..."
                    className="h-8 text-xs pl-8 font-mono"
                    data-testid="input-plate-search"
                  />
                  {plateSearch && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                      onClick={() => setPlateSearch('')}
                      data-testid="button-clear-search"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border">
                  {filteredByPlate.length === 0 ? (
                    <div className="text-center py-6 text-xs text-muted-foreground">
                      No plates match "{plateSearch}"
                    </div>
                  ) : (
                    filteredByPlate.map((s, i) => {
                      const knownProfile = profiles.find(p => p.plate.toUpperCase() === s.plate.toUpperCase());
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-3 px-3 py-2 border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors"
                          data-testid={`row-plate-${i}`}
                        >
                          <VehicleThumbnail imageUrl={s.image_url} plate={s.plate} size="md" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-mono font-semibold">{s.plate}</span>
                              {knownProfile?.label && (
                                <span className="text-xs text-muted-foreground truncate">({knownProfile.label})</span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {s.last_seen_camera || '—'}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs tabular-nums font-medium">{format(new Date(s.last_seen_at), 'h:mm a')}</p>
                            <Badge variant="outline" className="text-[10px] px-1 h-4">
                              {s.sightings_today}x
                            </Badge>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {plateSearch && filteredByPlate.length > 0 && (
                  <p className="text-xs text-muted-foreground text-center">
                    Showing {filteredByPlate.length} of {sightingsData.by_plate.length} plates
                  </p>
                )}
              </div>
            )}

            {recentSightings.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 px-1">
                  <Clock className="h-3.5 w-3.5" />
                  Today's Timeline ({totalSightings} sightings)
                </p>
                <div className="space-y-0.5">
                  {recentSightings.slice(0, timelineLimit).map((s, idx) => {
                    const knownProfile = profiles.find(p => p.plate.toUpperCase() === s.plate.toUpperCase());
                    return (
                      <div
                        key={`${s.plate}-${s.occurred_at}-${idx}`}
                        className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-muted/20"
                        data-testid={`timeline-entry-${idx}`}
                      >
                        {s.image_url ? (
                          <VehicleThumbnail imageUrl={s.image_url} plate={s.plate} size="sm" />
                        ) : (
                          <ArrowDownToLine className="h-3 w-3 text-primary shrink-0" />
                        )}
                        <span className="font-mono font-medium min-w-[80px]">
                          {knownProfile?.label || s.plate}
                        </span>
                        <span className="text-muted-foreground truncate flex-1">
                          {s.camera_name || 'detected'}
                        </span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {format(new Date(s.occurred_at), 'h:mm a')}
                        </span>
                      </div>
                    );
                  })}
                  {recentSightings.length > timelineLimit && !timelineExpanded && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-muted-foreground h-7"
                      onClick={() => setTimelineExpanded(true)}
                      data-testid="button-show-more-timeline"
                    >
                      Show {recentSightings.length - timelineLimit} more sightings
                    </Button>
                  )}
                  {timelineExpanded && totalSightings > 50 && (
                    <p className="text-xs text-muted-foreground text-center pt-1">
                      + {totalSightings - 50} more sightings today (showing most recent 50)
                    </p>
                  )}
                </div>
              </div>
            )}

            {recentSightings.length === 0 && profiles.length === 0 && !hasNoData && (
              <p className="text-sm text-muted-foreground text-center py-2">
                No vehicles seen yet today.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
