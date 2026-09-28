import { useState, useCallback, useEffect, useMemo } from 'react';
import { Flame, Loader2 } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Switch } from '@/components/ui/switch';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { callService, HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { useToast } from '@/hooks/use-toast';

interface FireplaceDef {
  name: string;
  display: string;
  matchKeys: string[];
}

const FIREPLACES: FireplaceDef[] = [
  { name: 'cabana Fireplace', display: 'Cabana', matchKeys: ['cabana', 'fireplace'] },
  { name: 'family room Fireplace', display: 'Family Room', matchKeys: ['family_room', 'fireplace'] },
  { name: 'formal living Fireplace', display: 'Formal Living', matchKeys: ['formal_living', 'fireplace'] },
  { name: 'primary bedroom Fireplace', display: 'Primary Bedroom', matchKeys: ['primary_bedroom', 'fireplace'] },
];

function sendOn(name: string) {
  return callService('google_assistant_sdk', 'send_text_command', { command: `turn on ${name}` });
}
function sendOff(name: string) {
  return callService('google_assistant_sdk', 'send_text_command', { command: `turn off ${name}` });
}

function findEntityState(entities: HAEntity[], matchKeys: string[]): boolean | null {
  const match = entities.find(e => {
    const id = e.entity_id.toLowerCase();
    return matchKeys.every(k => id.includes(k));
  });
  if (!match) return null;
  return match.state === 'on';
}

function FireplaceRow({ fp, initialState }: { fp: FireplaceDef; initialState: boolean | null }) {
  const { toast } = useToast();
  const [on, setOn] = useState(initialState ?? false);
  const [sending, setSending] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    if (initialState !== null) setOn(initialState);
  }, [initialState]);

  const doToggle = useCallback(async (turnOn: boolean) => {
    setSending(true);
    setOn(turnOn);
    try {
      await (turnOn ? sendOn(fp.name) : sendOff(fp.name));
      toast({ title: `${fp.display} fireplace turned ${turnOn ? 'on' : 'off'}` });
    } catch (e) {
      setOn(!turnOn);
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [fp, toast]);

  const handleToggle = useCallback((checked: boolean) => {
    if (checked) setConfirmOn(true);
    else setConfirmOff(true);
  }, []);

  return (
    <>
      <div className="flex items-center gap-2 py-2">
        <Flame className="h-4 w-4 text-orange-400 shrink-0" />
        <span className="text-sm font-medium truncate min-w-0 flex-1">{fp.display}</span>
        {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
        <Switch checked={on} onCheckedChange={handleToggle} disabled={sending} />
      </div>

      <AlertDialog open={confirmOn} onOpenChange={setConfirmOn}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on {fp.display} fireplace?</AlertDialogTitle>
            <AlertDialogDescription>This will ignite the fireplace. Make sure the flue is open.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => doToggle(true)}>Turn On</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off {fp.display} fireplace?</AlertDialogTitle>
            <AlertDialogDescription>This will extinguish the fireplace.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => doToggle(false)}>Turn Off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function CrestronFireplacesCard() {
  const { allEntities, loading } = useSharedHAAllEntities();

  const entityStates = useMemo(() => {
    const states: Record<string, boolean | null> = {};
    for (const fp of FIREPLACES) {
      states[fp.name] = findEntityState(allEntities, fp.matchKeys);
    }
    return states;
  }, [allEntities]);

  const activeCount = Object.values(entityStates).filter(v => v === true).length;

  return (
    <SystemCard
      title="Fireplaces"
      icon={<Flame className="h-6 w-6 text-orange-400" />}
      status="online"
      statusText={activeCount > 0 ? `${activeCount} on` : `${FIREPLACES.length} fireplaces`}
      accentColor="bg-orange-500/10"
      metrics={[{ label: 'Fireplaces', value: String(FIREPLACES.length) }]}
    >
      <div className="divide-y divide-border">
        {FIREPLACES.map(fp => (
          <FireplaceRow key={fp.name} fp={fp} initialState={entityStates[fp.name] ?? null} />
        ))}
      </div>
    </SystemCard>
  );
}
