import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SystemCard } from '../SystemCard';
import { Flame, Power, Clock, ThermometerSun, Palmtree } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';

const FIXED_TEMP = 190;
const FIXED_MINUTES = 45;
const FIXED_SECONDS = FIXED_MINUTES * 60;

function formatTimer(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SaunaLogicCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isOn, setIsOn] = useState(false);
  const [timerSecondsLeft, setTimerSecondsLeft] = useState(0);
  const [sending, setSending] = useState(false);
  const [togglingVacation, setTogglingVacation] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handlePowerRef = useRef<(turnOn: boolean) => Promise<void>>();

  // Fetch vacation mode from family_automations
  const { data: automation } = useQuery({
    queryKey: ['morning-sauna-automation'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<{ id: string; is_active: boolean; last_run_at: string | null }>({
        table: 'family_automations',
        select: 'id, is_active, last_run_at',
        filters: [{ column: 'name', op: 'eq', value: 'Morning Sauna' }],
      });
      return data;
    },
    staleTime: 30_000,
  });

  const vacationMode = automation ? !automation.is_active : false;

  const toggleVacation = useCallback(async () => {
    if (!automation) return;
    setTogglingVacation(true);
    try {
      const newActive = !automation.is_active;
      await apiClient.dbUpdate('family_automations', { is_active: newActive }, [
        { column: 'id', op: 'eq', value: automation.id },
      ]);
      queryClient.invalidateQueries({ queryKey: ['morning-sauna-automation'] });
      toast({ title: newActive ? 'Vacation mode OFF' : 'Vacation mode ON' });
    } catch (err) {
      toast({ title: 'Failed to toggle', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setTogglingVacation(false);
    }
  }, [automation, queryClient, toast]);

  // Timer countdown
  const hasTimeLeft = timerSecondsLeft > 0;
  useEffect(() => {
    if (isOn && hasTimeLeft) {
      timerRef.current = setInterval(() => {
        setTimerSecondsLeft(prev => {
          if (prev <= 1) {
            handlePowerRef.current?.(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isOn, hasTimeLeft]);

  const handlePower = useCallback(async (turnOn?: boolean) => {
    const next = turnOn ?? !isOn;
    setSending(true);
    try {
      const action = next ? 'start' : 'stop';
      const result = await apiClient.post<{ ok: boolean; partial?: boolean; error?: string; results?: { command: string; status: number }[] }>(
        '/api/automation/morning-sauna/control',
        { action },
      );
      if (result.partial) {
        toast({ title: 'Sauna partially started', description: 'Some commands had issues but the sauna should be running.', variant: 'default' });
      } else {
        toast({ title: next ? 'Sauna starting' : 'Sauna shutting down' });
      }
      setIsOn(next);
      if (next) {
        setTimerSecondsLeft(FIXED_SECONDS);
      } else {
        setTimerSecondsLeft(0);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Home Assistant may be temporarily unavailable.';
      toast({ title: 'Sauna command failed', description: detail, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [isOn, toast]);

  handlePowerRef.current = (turnOn: boolean) => handlePower(turnOn);

  const sessionProgress = isOn
    ? Math.min(100, Math.round((FIXED_SECONDS - timerSecondsLeft) / FIXED_SECONDS * 100))
    : 0;

  const metrics = [
    { label: 'Target', value: `${FIXED_TEMP}°F` },
    { label: 'Timer', value: isOn ? formatTimer(timerSecondsLeft) : `${FIXED_MINUTES} min` },
  ];

  return (
    <SystemCard
      title="SaunaLogic"
      icon={<Flame className="w-6 h-6 text-system-saunalogic" />}
      status={isOn ? 'warning' : 'idle'}
      statusText={isOn ? 'Heating' : vacationMode ? 'Vacation' : 'Standby'}
      metrics={metrics}
      accentColor="bg-system-saunalogic/10"
    >
      <div className="space-y-4">
        {/* Vacation mode indicator */}
        {vacationMode && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <Palmtree className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
              Vacation mode — morning automation paused
            </span>
          </div>
        )}

        {/* Session progress while running */}
        {isOn && (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Session progress</span>
              <span className="font-medium">{sessionProgress}%</span>
            </div>
            <Progress value={sessionProgress} className="h-2" />
          </div>
        )}

        {/* Fixed temp & session display */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <ThermometerSun className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Temperature</span>
          </div>
          <span className="text-sm font-semibold">{FIXED_TEMP}°F</span>
        </div>

        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Session length</span>
          </div>
          <span className="text-sm font-semibold">{FIXED_MINUTES} min</span>
        </div>

        {/* Vacation mode toggle */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30">
          <div className="flex items-center gap-2">
            <Palmtree className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Vacation mode</span>
          </div>
          <Switch
            checked={vacationMode}
            onCheckedChange={() => toggleVacation()}
            disabled={togglingVacation || !automation}
          />
        </div>

        {/* Power button */}
        <Button
          className="w-full gap-2"
          variant={isOn ? 'destructive' : 'default'}
          disabled={sending}
          onClick={() => handlePower()}
          data-testid="button-sauna-power"
        >
          <Power className="h-4 w-4" />
          {sending ? 'Sending…' : isOn ? 'Turn Off' : 'Start Sauna'}
        </Button>
      </div>
    </SystemCard>
  );
}
