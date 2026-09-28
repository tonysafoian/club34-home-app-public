import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Lock, Unlock, Loader2, AlertTriangle } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { lockLock, lockUnlock, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

function LockRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: (silent?: boolean) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const friendlyName = (entity.attributes?.friendly_name as string) || entity.entity_id;
  const roomName = entity.attributes?.room_name as string | undefined;
  const isLocked = entity.state === 'locked';
  const isJammed = entity.state === 'jammed';
  const isUnavailable = entity.state === 'unavailable';
  const connectionStatus = entity.attributes?.connection_status as string | undefined;
  const isCrestron = !!entity.attributes?.crestron_id;

  const rawBattery = entity.attributes?.battery_level ?? entity.attributes?.battery;
  const battery = typeof rawBattery === 'number' ? rawBattery : undefined;

  const handleToggle = async () => {
    setBusy(true);
    try {
      if (isLocked) {
        await lockUnlock(entity.entity_id);
        toast({ title: friendlyName, description: 'Unlocking...' });
      } else {
        await lockLock(entity.entity_id);
        toast({ title: friendlyName, description: 'Locking...' });
      }
      setTimeout(() => onRefresh(true), 2000);
    } catch (e: unknown) {
      toast({ title: `${friendlyName} error`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
      {isLocked ? (
        <Lock className="h-4 w-4 flex-shrink-0 text-emerald-500" />
      ) : isJammed ? (
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-destructive" />
      ) : isUnavailable ? (
        <Lock className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      ) : (
        <Unlock className="h-4 w-4 flex-shrink-0 text-amber-500" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium truncate block">{friendlyName}</span>
          {roomName && roomName !== friendlyName && (
            <span className="text-[10px] text-muted-foreground">({roomName})</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {battery !== undefined ? (
            <span className={`text-[10px] font-medium ${battery < 20 ? 'text-destructive font-semibold' : battery < 50 ? 'text-amber-500' : 'text-muted-foreground'}`}>
              Battery: {battery}%
            </span>
          ) : isCrestron ? (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${connectionStatus === 'online' ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
              Crestron {connectionStatus || 'Online'}
            </span>
          ) : null}
          <span className="text-[10px] text-muted-foreground">·</span>
          <span className={`text-[10px] capitalize ${isLocked ? 'text-emerald-500' : isJammed ? 'text-destructive' : isUnavailable ? 'text-muted-foreground' : 'text-amber-500'}`}>
            {entity.state}
          </span>
        </div>
      </div>
      {isJammed && (
        <Badge variant="destructive" className="text-[10px] px-1.5">Jammed</Badge>
      )}
      <Button
        variant={isLocked ? 'outline' : 'default'}
        size="sm"
        className="h-7 px-3 text-xs gap-1.5"
        onClick={handleToggle}
        disabled={busy || isUnavailable}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isLocked ? (
          <><Unlock className="h-3 w-3" /> Unlock</>
        ) : (
          <><Lock className="h-3 w-3" /> Lock</>
        )}
      </Button>
    </div>
  );
}

export function HALocksCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('lock');
  const lockedCount = entities.filter(e => e.state === 'locked').length;
  const jammedCount = entities.filter(e => e.state === 'jammed').length;

  const handleLockAll = async () => {
    const unlocked = entities.filter(e => e.state === 'unlocked');
    await Promise.all(unlocked.map(e => lockLock(e.entity_id)));
    setTimeout(() => refetch(true), 2000);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-5 w-5 text-primary" />
            Door Locks
          </CardTitle>
          <div className="flex items-center gap-2">
            {unavailable ? (
              <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
            ) : (
              <>
                {jammedCount > 0 && (
                  <Badge variant="destructive">{jammedCount} jammed</Badge>
                )}
                <Badge variant={lockedCount === entities.length ? 'secondary' : 'default'}>
                  {lockedCount}/{entities.length} locked
                </Badge>
                {lockedCount < entities.length && entities.length > 0 && (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handleLockAll}>
                    Lock All
                  </Button>
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
          <p className="text-sm text-muted-foreground text-center py-4">No lock entities found</p>
        ) : (
          <>
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {[...entities]
                .sort((a, b) => {
                  // Show unlocked/jammed first
                  const aPriority = a.state === 'jammed' ? 0 : a.state === 'unlocked' ? 1 : 2;
                  const bPriority = b.state === 'jammed' ? 0 : b.state === 'unlocked' ? 1 : 2;
                  return aPriority - bPriority;
                })
                .map(entity => (
                  <LockRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
                ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-3 pt-2 border-t border-border text-center">
              Yale locks integrated via Crestron Home &amp; Home Assistant
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
