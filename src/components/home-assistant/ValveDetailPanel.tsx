import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Droplets, Power, Loader2, X, Calendar, History, Pencil, Check, RotateCcw } from 'lucide-react';
import { ValveDef } from '@/lib/irrigation/controllers';
import { HAEntity, callService, getEntityHistory } from '@/lib/api/homeAssistant';
import { estimateGallons, formatGallons } from '@/hooks/useValveConfigs';
import { useToast } from '@/hooks/use-toast';

const MAX_ZONE_NAME_LEN = 80;

interface WateringSession {
  startTime: string;
  stopTime: string | null;
  durationMs: number | null;
}

function parseWateringSessions(
  entityHistory: Array<{ state: string; last_changed: string }>,
  currentState: string
): WateringSession[] {
  const sessions: WateringSession[] = [];
  let onTime: string | null = null;
  for (const entry of entityHistory) {
    if (entry.state === 'on' && onTime === null) {
      onTime = entry.last_changed;
    } else if (entry.state === 'off' && onTime !== null) {
      sessions.push({
        startTime: onTime,
        stopTime: entry.last_changed,
        durationMs: new Date(entry.last_changed).getTime() - new Date(onTime).getTime(),
      });
      onTime = null;
    }
  }
  if (onTime !== null && currentState === 'on') {
    sessions.push({ startTime: onTime, stopTime: null, durationMs: null });
  }
  return sessions.reverse();
}

function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${min} min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function formatRelative(dt: string): string {
  const d = new Date(dt);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMin / 60);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatTime(dt: string): string {
  return new Date(dt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

interface Props {
  valve: ValveDef;
  entity: HAEntity | undefined;
  onClose: () => void;
  onRefresh: () => void;
  nextEvent?: { summary: string; start: string } | null;
  /** When true, an inline rename control appears next to the zone name. */
  isAdmin?: boolean;
  /** Whether this zone currently has a saved custom name (enables Reset). */
  hasCustomName?: boolean;
  /** Persist a new friendly name for this zone. */
  onRenameZone?: (svgId: string, name: string) => void;
  /** Reset this zone's name back to the hardcoded default. */
  onResetZoneName?: (svgId: string) => void;
  /** A rename/reset mutation is in flight. */
  renamePending?: boolean;
  /** Persisted flow rate (GPM) for this zone; null/undefined hides gallons. */
  gpm?: number | null;
}

export function ValveDetailPanel({
  valve,
  entity,
  onClose,
  onRefresh,
  nextEvent,
  isAdmin = false,
  hasCustomName = false,
  onRenameZone,
  onResetZoneName,
  renamePending = false,
  gpm = null,
}: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<WateringSession[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(valve.label);

  // Reset the draft whenever a different zone is selected or its label changes.
  useEffect(() => {
    setNameDraft(valve.label);
    setEditingName(false);
  }, [valve.svgId, valve.label]);

  const commitRename = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast({ title: 'Name required', description: 'Zone name cannot be empty', variant: 'destructive' });
      return;
    }
    if (trimmed !== valve.label) onRenameZone?.(valve.svgId, trimmed);
    setEditingName(false);
  };

  const isOn = entity?.state === 'on';
  const connected = !!entity;

  const loadHistory = useCallback(async () => {
    if (!entity) return;
    setHistLoading(true);
    try {
      const raw = await getEntityHistory(entity.entity_id, 72);
      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        setSessions(parseWateringSessions(raw[0] as Array<{ state: string; last_changed: string }>, entity.state));
      }
    } catch {
      // ignore history fetch failures
    } finally {
      setHistLoading(false);
    }
  }, [entity]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleToggle = async () => {
    if (!entity) return;
    setBusy(true);
    try {
      await callService('switch', isOn ? 'turn_off' : 'turn_on', { entity_id: entity.entity_id });
      setTimeout(onRefresh, 800);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const lastSession = sessions[0];
  const prevSession = sessions.find(s => s.stopTime !== null);

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 min-w-0"
      data-testid={`valve-detail-panel-${valve.svgId}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-medium">{valve.clockName}</p>
          {editingName ? (
            <div className="flex items-center gap-1 mt-0.5">
              <Input
                value={nameDraft}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  else if (e.key === 'Escape') { setNameDraft(valve.label); setEditingName(false); }
                }}
                maxLength={MAX_ZONE_NAME_LEN}
                autoFocus
                disabled={renamePending}
                className="h-7 text-sm"
                aria-label="Zone name"
                data-testid="input-zone-name"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={commitRename}
                disabled={renamePending}
                aria-label="Save zone name"
                data-testid="button-zone-name-save"
              >
                {renamePending ? <Loader2 className="h-3.5 w-3.5 animate-spin"/> : <Check className="h-3.5 w-3.5"/>}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-semibold leading-tight truncate" data-testid="text-zone-name">{valve.label}</h3>
              {isAdmin && (
                <>
                  <button
                    onClick={() => { setNameDraft(valve.label); setEditingName(true); }}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    aria-label="Rename zone"
                    data-testid="button-zone-name-edit"
                  >
                    <Pencil className="h-3 w-3"/>
                  </button>
                  {hasCustomName && (
                    <button
                      onClick={() => onResetZoneName?.(valve.svgId)}
                      disabled={renamePending}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      aria-label="Reset zone name to default"
                      data-testid="button-zone-name-reset"
                    >
                      <RotateCcw className="h-3 w-3"/>
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {entity && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">{entity.attributes?.friendly_name as string || entity.entity_id}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Close valve detail"
          data-testid="button-valve-panel-close"
        >
          <X className="h-4 w-4"/>
        </button>
      </div>

      {/* State badge */}
      <div className="flex items-center gap-2">
        {!connected ? (
          <Badge variant="outline" className="text-muted-foreground text-xs">
            Not connected
          </Badge>
        ) : isOn ? (
          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse"/>
            Running
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-xs">Off</Badge>
        )}
      </div>

      {/* Last run */}
      {connected && (
        <div className="space-y-1">
          {histLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin"/>
              Loading history…
            </div>
          ) : lastSession ? (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <History className="h-3 w-3 shrink-0"/>
                <span className="font-medium">Last run</span>
              </div>
              {prevSession ? (
                <div className="rounded border border-border bg-muted/20 px-2.5 py-1.5 text-xs flex items-center gap-2">
                  <span className="text-muted-foreground">{formatRelative(prevSession.startTime)}</span>
                  <span className="text-muted-foreground">·</span>
                  <span>{formatTime(prevSession.startTime)}</span>
                  {prevSession.durationMs !== null && (
                    <div className="flex items-center gap-1 ml-auto">
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                        {formatDuration(prevSession.durationMs)}
                      </Badge>
                      {gpm !== null && (
                        <Badge
                          variant="secondary"
                          className="text-[10px] h-4 px-1.5 bg-blue-500/15 text-blue-400"
                          data-testid="badge-last-run-gallons"
                        >
                          {formatGallons(estimateGallons(gpm, prevSession.durationMs))}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              ) : isOn ? (
                <div className="rounded border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-400">
                  Running since {formatTime(lastSession.startTime)} · {formatDuration(Date.now() - new Date(lastSession.startTime).getTime())}
                  {gpm !== null && (
                    <> · {formatGallons(estimateGallons(gpm, Date.now() - new Date(lastSession.startTime).getTime()))}</>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <History className="h-3 w-3"/>
              No runs in last 72h
            </div>
          )}

          {/* Next scheduled */}
          {nextEvent && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
              <Calendar className="h-3 w-3 shrink-0"/>
              <span className="font-medium">Next:</span>
              <span className="truncate">{nextEvent.summary}</span>
              <span className="shrink-0">{formatRelative(nextEvent.start)}</span>
            </div>
          )}
        </div>
      )}

      {/* Toggle */}
      <Button
        variant={isOn ? 'default' : 'outline'}
        size="sm"
        className="w-full h-8 text-xs"
        disabled={!connected || busy}
        onClick={handleToggle}
        data-testid={`button-valve-toggle-${valve.svgId}`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1.5"/>
        ) : (
          <>{isOn ? <Power className="h-3 w-3 mr-1.5"/> : <Droplets className="h-3 w-3 mr-1.5"/>}</>
        )}
        {!connected ? 'Not connected' : isOn ? 'Stop valve' : 'Run valve'}
      </Button>
    </div>
  );
}
