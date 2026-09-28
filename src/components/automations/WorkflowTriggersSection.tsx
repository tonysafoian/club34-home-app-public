import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Zap, ArrowRight, Lightbulb, CheckCircle2, Loader2, XCircle, Info, RefreshCw, AlertTriangle, Wrench,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  WORKFLOW_RULES, resolveWorkflow, deployWorkflowToHA, getWorkflowHAStatus,
  type WorkflowRule, type ResolvedWorkflow,
} from '@/lib/workflowTriggers';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { apiClient } from '@/lib/apiClient';

interface ServerWorkflowStatus {
  ruleId: string;
  name: string;
  bidirectional: boolean;
  forwardExists: boolean;
  forwardState: string | null;
  reverseExists: boolean;
  reverseState: string | null;
  status: 'live' | 'missing' | 'error' | 'unknown';
  lastAutoHealedAt: string | null;
}

interface ServerWorkflowStatusResponse {
  haConfigured: boolean;
  haError: string | null;
  lastReconcileRunAt: string | null;
  rules: ServerWorkflowStatus[];
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function WorkflowRuleCard({ rule, serverStatus }: { rule: WorkflowRule; serverStatus?: ServerWorkflowStatus }) {
  const { allEntities } = useSharedHAAllEntities();
  const [haStatus, setHaStatus] = useState<{
    exists: boolean;
    state: string | null;
    forwardExists?: boolean;
    forwardState?: string | null;
    reverseExists?: boolean;
    reverseState?: string | null;
  } | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Track which set of targets was last deployed. When entity availability
  // changes (switch fallback kicks in/clears), the fingerprint shifts and
  // we auto-redeploy to keep the live HA automation in sync.
  const deployedFingerprintRef = useRef<string | null>(null);

  const resolved = useMemo<ResolvedWorkflow | null>(
    () => allEntities.length > 0 ? resolveWorkflow(rule, allEntities) : null,
    [allEntities, rule],
  );

  // Entities that are unavailable AND have no fallback (i.e. not in fallbackEntityIds)
  const offlineEntities = useMemo<string[]>(() => {
    if (!resolved || allEntities.length === 0) return [];
    const ids = [resolved.triggerEntityId, ...(resolved.targetEntityIds || [])];
    return ids.filter((id) => {
      // If this is already a switch fallback, it's reachable — not "offline"
      if (resolved.fallbackEntityIds.includes(id)) return false;
      const e = allEntities.find((x) => x.entity_id === id);
      return e && (e.state === 'unavailable' || e.state === 'unknown');
    });
  }, [resolved, allEntities]);

  // Targets that fell back to switch.* because their light.* was unavailable
  const fallbackEntities = useMemo<string[]>(() => {
    if (!resolved) return [];
    return resolved.fallbackEntityIds;
  }, [resolved]);

  const syncToHA = useCallback(async (force = false) => {
    if (allEntities.length === 0 || !resolved) return;

    // Include reverse trigger in the fingerprint so changes to the TigerDen
    // entity (e.g. fallback activates) also trigger a redeploy.
    const fingerprintParts = [...resolved.targetEntityIds];
    if (resolved.reverseTriggerEntityId) fingerprintParts.push(resolved.reverseTriggerEntityId);
    const fingerprint = fingerprintParts.sort().join(',');
    const fingerprintChanged = fingerprint !== deployedFingerprintRef.current;

    // Skip if nothing changed and not forced
    if (!force && !fingerprintChanged) return;
    deployedFingerprintRef.current = fingerprint;

    setSyncing(true);
    try {
      if (!force && !fingerprintChanged) {
        const status = await getWorkflowHAStatus(rule);
        if (status.exists && status.state === 'on') {
          setHaStatus(status);
          setSyncing(false);
          return;
        }
      }
      await deployWorkflowToHA(rule, allEntities);
      // Fetch actual HA status after deploy — never assume success.
      // For bidirectional rules this catches cases where the reverse automation
      // could not be deployed (unresolvable entity), keeping the UI honest.
      const postDeployStatus = await getWorkflowHAStatus(rule);
      setHaStatus(postDeployStatus);
    } catch {
      setHaStatus({ exists: false, state: null });
    } finally {
      setSyncing(false);
    }
  }, [allEntities, resolved, rule]);

  useEffect(() => { syncToHA(); }, [syncToHA]);

  const isDeployed = haStatus?.exists && haStatus.state === 'on';
  const isBidirectional = !!rule.bidirectional;
  const forwardExists = !!haStatus?.forwardExists;
  const forwardLive = forwardExists && haStatus?.forwardState === 'on';
  const reverseExists = !!haStatus?.reverseExists;
  const reverseLive = reverseExists && haStatus?.reverseState === 'on';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Zap className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{rule.name}</CardTitle>
              <CardDescription className="text-xs">{rule.description}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {serverStatus && (
              <Badge
                variant="outline"
                className={
                  serverStatus.status === 'live'
                    ? 'border-green-500/30 text-green-500 gap-1'
                    : serverStatus.status === 'missing'
                    ? 'border-amber-500/40 text-amber-500 gap-1'
                    : serverStatus.status === 'error'
                    ? 'border-red-500/30 text-red-400 gap-1'
                    : 'border-muted-foreground/30 text-muted-foreground gap-1'
                }
                title={
                  serverStatus.status === 'live'
                    ? 'All HA automations for this rule are deployed and enabled'
                    : serverStatus.status === 'missing'
                    ? 'One or more HA automations are missing or disabled — the reconciler will auto-heal on the next run (every 30 min)'
                    : serverStatus.status === 'error'
                    ? 'Home Assistant is unreachable or not configured — cannot verify automation health'
                    : 'HA automation status not yet known'
                }
                data-testid={`badge-health-${rule.id}`}
              >
                {serverStatus.status === 'live' ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : serverStatus.status === 'missing' ? (
                  <AlertTriangle className="h-3 w-3" />
                ) : serverStatus.status === 'error' ? (
                  <XCircle className="h-3 w-3" />
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {serverStatus.status === 'live'
                  ? 'Live in HA'
                  : serverStatus.status === 'missing'
                  ? 'Missing — redeploying'
                  : serverStatus.status === 'error'
                  ? 'Error'
                  : 'Checking…'}
              </Badge>
            )}
            {syncing ? (
              <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground gap-1">
                <Loader2 className="h-3 w-3 animate-spin" /> Syncing
              </Badge>
            ) : isBidirectional ? (
              <>
                <Badge
                  variant="outline"
                  className={
                    forwardLive
                      ? 'border-green-500/30 text-green-500 gap-1'
                      : forwardExists
                      ? 'border-amber-500/40 text-amber-500 gap-1'
                      : 'border-red-500/30 text-red-400 gap-1'
                  }
                  title={
                    forwardLive
                      ? 'Forward automation is deployed and enabled in HA'
                      : forwardExists
                      ? 'Forward automation exists in HA but is disabled'
                      : 'Forward automation is missing in HA'
                  }
                  data-testid={`badge-forward-${rule.id}`}
                >
                  {forwardLive ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : forwardExists ? (
                    <AlertTriangle className="h-3 w-3" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Forward{forwardLive ? ' live' : forwardExists ? ' disabled' : ' missing'}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    reverseLive
                      ? 'border-green-500/30 text-green-500 gap-1'
                      : reverseExists
                      ? 'border-amber-500/40 text-amber-500 gap-1'
                      : 'border-red-500/30 text-red-400 gap-1'
                  }
                  title={
                    reverseLive
                      ? 'Reverse automation is deployed and enabled in HA'
                      : reverseExists
                      ? 'Reverse automation exists in HA but is disabled'
                      : 'Reverse automation is missing in HA — half of the bidirectional sync is broken'
                  }
                  data-testid={`badge-reverse-${rule.id}`}
                >
                  {reverseLive ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : reverseExists ? (
                    <AlertTriangle className="h-3 w-3" />
                  ) : (
                    <XCircle className="h-3 w-3" />
                  )}
                  Reverse{reverseLive ? ' live' : reverseExists ? ' disabled' : ' missing'}
                </Badge>
                {isDeployed && offlineEntities.length > 0 && (
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 text-amber-500 gap-1"
                    title={`Offline lights (no fallback): ${offlineEntities.join(', ')}`}
                    data-testid={`badge-offline-${rule.id}`}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {offlineEntities.length} offline
                  </Badge>
                )}
                {isDeployed && fallbackEntities.length > 0 && (
                  <Badge
                    variant="outline"
                    className="border-blue-500/40 text-blue-400 gap-1"
                    title={`Using switch fallback: ${fallbackEntities.join(', ')}`}
                    data-testid={`badge-fallback-${rule.id}`}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    {fallbackEntities.length} on fallback
                  </Badge>
                )}
              </>
            ) : isDeployed && offlineEntities.length > 0 ? (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-500 gap-1"
                title={`Offline lights (no fallback): ${offlineEntities.join(', ')}`}
                data-testid={`badge-offline-${rule.id}`}
              >
                <AlertTriangle className="h-3 w-3" />
                {offlineEntities.length} light{offlineEntities.length === 1 ? '' : 's'} offline
              </Badge>
            ) : isDeployed && fallbackEntities.length > 0 ? (
              <Badge
                variant="outline"
                className="border-blue-500/40 text-blue-400 gap-1"
                title={`Using switch fallback: ${fallbackEntities.join(', ')}`}
                data-testid={`badge-fallback-${rule.id}`}
              >
                <AlertTriangle className="h-3 w-3" />
                {fallbackEntities.length} on switch fallback
              </Badge>
            ) : isDeployed ? (
              <Badge variant="outline" className="border-green-500/30 text-green-500 gap-1">
                <CheckCircle2 className="h-3 w-3" /> Live in HA
              </Badge>
            ) : (
              <Badge variant="outline" className="border-red-500/30 text-red-400 gap-1">
                <XCircle className="h-3 w-3" /> Deploy failed
              </Badge>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => syncToHA(true)}
              disabled={syncing || !resolved}
              title={
                isBidirectional
                  ? 'Redeploy both forward and reverse automations to HA'
                  : 'Redeploy to HA'
              }
              aria-label={
                isBidirectional
                  ? 'Redeploy forward and reverse automations'
                  : 'Redeploy automation'
              }
              data-testid={`button-redeploy-${rule.id}`}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Trigger → Targets flow */}
        <div className="flex items-start gap-2 text-sm">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-yellow-500/10 border border-yellow-500/20 shrink-0">
            <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />
            <span className="font-medium text-yellow-600 dark:text-yellow-400">{rule.triggerLabel}</span>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1.5" />
          <div className="flex flex-wrap gap-1.5">
            {rule.targetLabels.map(label => (
              <span key={label} className="px-2.5 py-1.5 rounded-md bg-green-500/10 border border-green-500/20 text-xs font-medium text-green-600 dark:text-green-400">
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Resolved entities */}
        {allEntities.length > 0 && (
          <div className="text-xs text-muted-foreground space-y-1 pt-2 border-t">
            {resolved ? (
              <>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-green-500" />
                  <span>
                    Trigger: <span className="font-medium text-foreground">{resolved.triggerName}</span>
                    <span className="text-muted-foreground/60 ml-1">({resolved.triggerEntityId})</span>
                  </span>
                </div>
                <div className="flex items-start gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5" />
                  <span>
                    Targets ({resolved.targetEntityIds.length}): <span className="font-medium text-foreground">{resolved.targetNames.join(', ')}</span>
                    <span className="text-muted-foreground/60 ml-1">
                      ({resolved.targetEntityIds.join(', ')})
                    </span>
                    {resolved.fallbackEntityIds.length > 0 && (
                      <span className="ml-1 text-blue-400">
                        · {resolved.fallbackEntityIds.join(', ')} via switch fallback
                      </span>
                    )}
                  </span>
                </div>
                {isBidirectional && (
                  resolved.reverseTriggerEntityId ? (
                    <>
                      <div className="flex items-center gap-1.5 pt-1 border-t border-dashed border-muted-foreground/20 mt-1">
                        <CheckCircle2 className="h-3 w-3 text-green-500" />
                        <span data-testid={`text-reverse-trigger-${rule.id}`}>
                          Reverse trigger: <span className="font-medium text-foreground">{resolved.reverseTriggerName}</span>
                          <span className="text-muted-foreground/60 ml-1">({resolved.reverseTriggerEntityId})</span>
                        </span>
                      </div>
                      {resolved.reverseTargetEntityIds && resolved.reverseTargetEntityIds.length > 0 && (
                        <div className="flex items-start gap-1.5">
                          <CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5" />
                          <span data-testid={`text-reverse-targets-${rule.id}`}>
                            Reverse targets ({resolved.reverseTargetEntityIds.length}): <span className="font-medium text-foreground">{resolved.reverseTargetEntityIds.join(', ')}</span>
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5 pt-1 border-t border-dashed border-muted-foreground/20 mt-1">
                      <XCircle className="h-3 w-3 text-destructive" />
                      <span data-testid={`text-reverse-missing-${rule.id}`}>
                        Reverse trigger entity could not be resolved — reverse automation will not deploy
                      </span>
                    </div>
                  )
                )}
              </>
            ) : (
              <div
                className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-red-500"
                data-testid={`banner-unresolved-${rule.id}`}
              >
                <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="space-y-0.5">
                  <div className="font-medium">Could not resolve HA entities for this rule</div>
                  <div className="text-[11px] opacity-90">
                    Expected trigger <span className="font-mono">{rule.triggerLabel}</span>
                    {' '}and target{rule.targetLabels.length === 1 ? '' : 's'}{' '}
                    <span className="font-mono">{rule.targetLabels.join(', ')}</span>.
                    {' '}Check the Home Assistant integration — this rule will not deploy until both sides are available.
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {serverStatus?.lastAutoHealedAt && (
          <div
            className="text-[11px] text-muted-foreground flex items-center gap-1 pt-1"
            data-testid={`text-last-autohealed-${rule.id}`}
            title={`Last auto-healed at ${new Date(serverStatus.lastAutoHealedAt).toLocaleString()}`}
          >
            <Wrench className="h-3 w-3" />
            Last auto-healed {formatRelative(serverStatus.lastAutoHealedAt)} by the reconciler
          </div>
        )}

        {isDeployed && (
          <div className="text-[10px] text-muted-foreground flex items-center gap-1 pt-1">
            <Info className="h-3 w-3" />
            Runs server-side — fires from any source (physical switch, HA app, Google Home, Janus)
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowTriggersInner() {
  const { data: statusData, error: statusError } = useQuery<ServerWorkflowStatusResponse>({
    queryKey: ['/api/ha-workflow-status'],
    queryFn: () => apiClient.get<ServerWorkflowStatusResponse>('/api/ha-workflow-status'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const statusByRule = useMemo(() => {
    const map = new Map<string, ServerWorkflowStatus>();
    statusData?.rules?.forEach((s) => map.set(s.ruleId, s));
    return map;
  }, [statusData]);

  // If the status endpoint itself errors, synthesize an 'error' status per rule
  // so the health badge still shows red instead of silently disappearing.
  const fallbackStatus = useCallback(
    (rule: WorkflowRule): ServerWorkflowStatus | undefined => {
      if (!statusError) return undefined;
      return {
        ruleId: rule.id,
        name: rule.name,
        bidirectional: !!rule.bidirectional,
        forwardExists: false,
        forwardState: null,
        reverseExists: false,
        reverseState: null,
        status: 'error',
        lastAutoHealedAt: null,
      };
    },
    [statusError],
  );


  return (
    <div className="space-y-3">
      {statusError && (
        <div
          className="text-xs text-red-400 flex items-center gap-1.5 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/5"
          data-testid="text-workflow-status-error"
        >
          <XCircle className="h-3.5 w-3.5" />
          Could not load workflow automation health from the server — badges may be stale.
        </div>
      )}
      {WORKFLOW_RULES.length === 0 ? (
        <p className="text-muted-foreground text-sm">No workflow triggers configured yet.</p>
      ) : (
        WORKFLOW_RULES.map(rule => (
          <WorkflowRuleCard
            key={rule.id}
            rule={rule}
            serverStatus={statusByRule.get(rule.id) ?? fallbackStatus(rule)}
          />
        ))
      )}
    </div>
  );
}

export function WorkflowTriggersSection() {
  return <WorkflowTriggersInner />;
}
