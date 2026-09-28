import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Shield, ShieldCheck, ShieldAlert, ShieldOff, Loader2, Moon, Home, LogOut } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { alarmArmAway, alarmArmHome, alarmArmNight, alarmDisarm, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

const STATE_CONFIG: Record<string, { label: string; color: string; icon: typeof Shield; badgeVariant: 'default' | 'secondary' | 'destructive' }> = {
  armed_away: { label: 'Armed Away', color: 'text-red-500', icon: ShieldCheck, badgeVariant: 'destructive' },
  armed_home: { label: 'Armed Home', color: 'text-orange-500', icon: ShieldCheck, badgeVariant: 'default' },
  armed_night: { label: 'Armed Night', color: 'text-purple-500', icon: ShieldCheck, badgeVariant: 'default' },
  armed_custom_bypass: { label: 'Armed (Bypass)', color: 'text-yellow-500', icon: ShieldCheck, badgeVariant: 'default' },
  disarmed: { label: 'Disarmed', color: 'text-green-500', icon: ShieldOff, badgeVariant: 'secondary' },
  pending: { label: 'Pending', color: 'text-yellow-500', icon: ShieldAlert, badgeVariant: 'secondary' },
  arming: { label: 'Arming...', color: 'text-yellow-500', icon: ShieldAlert, badgeVariant: 'secondary' },
  disarming: { label: 'Disarming...', color: 'text-yellow-500', icon: ShieldAlert, badgeVariant: 'secondary' },
  triggered: { label: 'TRIGGERED', color: 'text-red-600', icon: ShieldAlert, badgeVariant: 'destructive' },
};

function AlarmPanelRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: (silent?: boolean) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const friendlyName = (entity.attributes?.friendly_name as string) || entity.entity_id;
  const state = entity.state;
  const config = STATE_CONFIG[state] || { label: state, color: 'text-muted-foreground', icon: Shield, badgeVariant: 'secondary' as const };
  const StateIcon = config.icon;
  const codeRequired = entity.attributes?.code_required !== false;
  const isArmed = state.startsWith('armed');
  const changedAt = entity.attributes?.changed_by as string | undefined;

  const executeAction = async (action: string, actionCode?: string) => {
    setBusy(true);
    try {
      switch (action) {
        case 'arm_away': await alarmArmAway(entity.entity_id, actionCode); break;
        case 'arm_home': await alarmArmHome(entity.entity_id, actionCode); break;
        case 'arm_night': await alarmArmNight(entity.entity_id, actionCode); break;
        case 'disarm': await alarmDisarm(entity.entity_id, actionCode); break;
      }
      toast({ title: friendlyName, description: `${action.replace('_', ' ')} command sent` });
      setCode('');
      setShowCode(false);
      setPendingAction(null);
      setTimeout(() => onRefresh(true), 2000);
    } catch (e: unknown) {
      toast({ title: `${friendlyName} error`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleAction = (action: string) => {
    if (codeRequired && action === 'disarm') {
      setPendingAction(action);
      setShowCode(true);
      return;
    }
    executeAction(action);
  };

  const handleCodeSubmit = () => {
    if (!pendingAction || !code) return;
    executeAction(pendingAction, code);
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
      <div className="flex items-center gap-3">
        <StateIcon className={`h-5 w-5 flex-shrink-0 ${config.color}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{friendlyName}</p>
          {changedAt && (
            <p className="text-[10px] text-muted-foreground">Last changed by: {changedAt}</p>
          )}
        </div>
        <Badge variant={config.badgeVariant}>{config.label}</Badge>
      </div>

      {/* Arm/Disarm Buttons */}
      <div className="flex flex-wrap gap-2">
        {!isArmed && state !== 'arming' && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => handleAction('arm_away')}
              disabled={busy}
            >
              <LogOut className="h-3 w-3" />
              Arm Away
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => handleAction('arm_home')}
              disabled={busy}
            >
              <Home className="h-3 w-3" />
              Arm Home
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => handleAction('arm_night')}
              disabled={busy}
            >
              <Moon className="h-3 w-3" />
              Arm Night
            </Button>
          </>
        )}
        {(isArmed || state === 'triggered' || state === 'pending') && (
          <Button
            variant="destructive"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => handleAction('disarm')}
            disabled={busy}
          >
            <ShieldOff className="h-3 w-3" />
            Disarm
          </Button>
        )}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground self-center" />}
      </div>

      {/* Code Entry */}
      {showCode && (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder="Enter code"
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCodeSubmit()}
            className="h-8 text-sm flex-1"
            autoFocus
          />
          <Button size="sm" className="h-8" onClick={handleCodeSubmit} disabled={!code || busy}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Submit'}
          </Button>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setShowCode(false); setPendingAction(null); setCode(''); }}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

export function HAAlarmCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('alarm_control_panel');

  const armedCount = entities.filter(e => e.state.startsWith('armed')).length;
  const triggeredCount = entities.filter(e => e.state === 'triggered').length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-5 w-5 text-red-500" />
            Alarm System
          </CardTitle>
          <div className="flex items-center gap-2">
            {unavailable ? (
              <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
            ) : (
              <>
                {triggeredCount > 0 && (
                  <Badge variant="destructive" className="animate-pulse">
                    TRIGGERED
                  </Badge>
                )}
                {triggeredCount === 0 && (
                  <Badge variant={armedCount > 0 ? 'default' : 'secondary'}>
                    {armedCount > 0 ? `${armedCount} Armed` : 'Disarmed'}
                  </Badge>
                )}
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entities.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <Shield className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No alarm panels found</p>
            <p className="text-xs text-muted-foreground">
              Install the Alarm.com integration via HACS to connect your alarm system.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entities.map(entity => (
              <AlarmPanelRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
