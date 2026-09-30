import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Thermometer, CheckCircle2, XCircle, Clock, Zap, Wind, Radio } from 'lucide-react';
import { format } from 'date-fns';
import { apiClient } from '@/lib/apiClient';
import {
  GYM_SCHEDULE,
  THEATER_SCHEDULE,
  GYM_HEAT_TEMP,
  GYM_COOL_TEMP,
  THEATER_HEAT_TEMP,
  THEATER_COOL_TEMP,
  isWithinSchedule,
  type ScheduleWindow,
} from '@shared/scheduleWindows';
import {
  ResponsiveContainer, LineChart, Line, Tooltip,
} from 'recharts';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { useAvClosetReading } from '@/hooks/useAvClosetReading';
import {
  findAvClosetTempSensor,
  AV_CLOSET_WARN_TEMP,
  AV_CLOSET_CRITICAL_TEMP,
  AV_CLOSET_PLACEHOLDER_TITLE,
  AV_CLOSET_PLACEHOLDER_DETAIL,
  AV_CLOSET_THRESHOLD_NOTE,
} from '@shared/avCloset';

// ── Types ────────────────────────────────────────────────────────────────────

interface ThermostatLog {
  id: string;
  entity_id: string;
  friendly_name: string | null;
  current_temperature: string | null;
  target_temperature: string | null;
  hvac_mode: string | null;
  hvac_action: string | null;
  logged_at: string;
}

interface HistoryResponse {
  logs: ThermostatLog[];
  count: number;
}

interface HAClimateState {
  entity_id: string;
  state: string;
  attributes?: {
    friendly_name?: string;
    current_temperature?: number | string | null;
    temperature?: number | string | null;
    hvac_action?: string | null;
  };
}

interface LiveReading {
  friendly_name: string | null;
  current_temperature: number | null;
  target_temperature: number | null;
  hvac_mode: string | null;
  hvac_action: string | null;
  fetched_at: string;
}

const POOL_SPA_RE = /pool|spa/i;

// ── Constants ────────────────────────────────────────────────────────────────

const GYM_ENTITY_ID = 'climate.gym_gym';
const THEATER_ENTITY_ID = 'climate.theater_theater';

// Per-entity automation config for thermostats that have schedule enforcement
interface AutomationConfig {
  schedule: ScheduleWindow;
  scheduleLabel: string;
  getScheduleState: () => 'active' | 'standby';
  heatTemp: number;
  coolTemp: number;
  bandLabel: string;
}

function buildAutomationConfig(
  schedule: ScheduleWindow,
  heatTemp: number,
  coolTemp: number,
): AutomationConfig {
  return {
    schedule,
    scheduleLabel: `${schedule.label} schedule · ${coolTemp}°F cool / ${heatTemp}°F heat`,
    getScheduleState: () => (isWithinSchedule(schedule) ? 'active' : 'standby'),
    heatTemp,
    coolTemp,
    bandLabel: `${heatTemp}–${coolTemp}°F`,
  };
}

const THERMOSTAT_AUTOMATION: Record<string, AutomationConfig> = {
  [GYM_ENTITY_ID]: buildAutomationConfig(GYM_SCHEDULE, GYM_HEAT_TEMP, GYM_COOL_TEMP),
  [THEATER_ENTITY_ID]: buildAutomationConfig(THEATER_SCHEDULE, THEATER_HEAT_TEMP, THEATER_COOL_TEMP),
};

// Colors per HVAC mode
const MODE_COLORS: Record<string, { bg: string; text: string; border: string; line: string }> = {
  cool:      { bg: 'bg-blue-500/10',   text: 'text-blue-400',   border: 'border-blue-500/30',   line: '#60a5fa' },
  heat:      { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30', line: '#fb923c' },
  heat_cool: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30', line: '#a78bfa' },
  off:       { bg: 'bg-muted/20',      text: 'text-muted-foreground', border: 'border-border', line: '#6b7280' },
  fan_only:  { bg: 'bg-teal-500/10',   text: 'text-teal-400',   border: 'border-teal-500/30',   line: '#2dd4bf' },
};

function modeStyle(mode: string | null) {
  return MODE_COLORS[mode ?? 'off'] ?? MODE_COLORS.off;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip HA's duplicate room names: "Gym Gym" → "Gym", "Bedroom 1 Bedroom 1" → "Bedroom 1" */
function cleanName(raw: string | null): string {
  if (!raw) return '';
  const parts = raw.trim().split(/\s+/);
  const half = Math.floor(parts.length / 2);
  if (parts.length >= 2 && parts.length % 2 === 0) {
    const first = parts.slice(0, half).join(' ');
    const second = parts.slice(half).join(' ');
    if (first.toLowerCase() === second.toLowerCase()) return first;
  }
  return raw.trim();
}

// ── Mini Sparkline ────────────────────────────────────────────────────────────

interface SparkPoint { t: string; v: number | null; target: number | null }

function MiniSparkline({ data, mode, lineColor }: { data: SparkPoint[]; mode: string | null; lineColor?: string }) {
  const style = modeStyle(mode);
  const stroke = lineColor ?? style.line;
  const vals = data.map(d => d.v).filter((v): v is number => v !== null);
  const min = vals.length ? Math.min(...vals) - 1 : 60;
  const max = vals.length ? Math.max(...vals) + 1 : 80;

  return (
    <ResponsiveContainer width="100%" height={52}>
      <LineChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '6px',
            fontSize: '10px',
            padding: '4px 8px',
          }}
          labelFormatter={label => label}
          formatter={(value: number) => [`${value}°F`, 'temp']}
        />
        <Line
          type="monotone"
          dataKey="v"
          stroke={stroke}
          strokeWidth={1.5}
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="target"
          stroke={style.line}
          strokeWidth={1}
          strokeDasharray="3 3"
          dot={false}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── Individual Thermostat Card ────────────────────────────────────────────────

function ThermostatCard({
  entityId,
  logs,
  live,
}: {
  entityId: string;
  logs: ThermostatLog[];
  live: LiveReading | null;
}) {
  const myLogs = logs.filter(l => l.entity_id === entityId);
  const latest = myLogs[myLogs.length - 1];
  const automationConfig = THERMOSTAT_AUTOMATION[entityId] ?? null;

  // Prefer live HA reading; fall back to most recent logged reading.
  const loggedTemp = latest?.current_temperature ? parseFloat(latest.current_temperature) : null;
  const loggedTarget = latest?.target_temperature ? parseFloat(latest.target_temperature) : null;

  const currentTemp = live?.current_temperature ?? loggedTemp;
  const targetTemp = live?.target_temperature ?? loggedTarget;
  const hvacMode = live?.hvac_mode ?? latest?.hvac_mode ?? null;
  const hvacAction = live?.hvac_action ?? latest?.hvac_action ?? null;
  const name = cleanName(live?.friendly_name ?? latest?.friendly_name ?? entityId);

  const isLive = !!live;
  const updatedAt = live ? new Date(live.fetched_at) : (latest ? new Date(latest.logged_at) : null);
  const lastUpdated = updatedAt ? format(updatedAt, 'h:mm a') : null;
  const style = modeStyle(hvacMode);

  // Build sparkline data (last 12 readings)
  const sparkData: SparkPoint[] = myLogs.slice(-12).map(l => ({
    t: format(new Date(l.logged_at), 'h:mm a'),
    v: l.current_temperature ? parseFloat(l.current_temperature) : null,
    target: l.target_temperature ? parseFloat(l.target_temperature) : null,
  }));

  // Automation-specific derived state
  const scheduleState = automationConfig ? automationConfig.getScheduleState() : null;
  const tempInRange = automationConfig && currentTemp !== null
    ? currentTemp >= automationConfig.heatTemp && currentTemp <= automationConfig.coolTemp
    : null;

  return (
    <Card className={`overflow-hidden transition-shadow hover:shadow-md ${automationConfig ? 'border-primary/30' : ''}`}>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${style.bg}`}>
              {hvacMode === 'fan_only' ? (
                <Wind className={`w-4 h-4 ${style.text}`} />
              ) : (
                <Thermometer className={`w-4 h-4 ${style.text}`} />
              )}
            </div>
            <div>
              <CardTitle className="text-sm font-semibold leading-tight">{name}</CardTitle>
              {automationConfig && (
                <p className="text-[10px] text-muted-foreground">{automationConfig.scheduleLabel}</p>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {hvacMode && (
              <Badge variant="outline" className={`text-[10px] py-0 ${style.bg} ${style.text} ${style.border}`}>
                {hvacMode}
              </Badge>
            )}
            {isLive && (
              <Badge
                variant="outline"
                className="text-[10px] py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                data-testid={`badge-live-${entityId}`}
              >
                <Radio className="w-2.5 h-2.5 mr-1" />Live
              </Badge>
            )}
            {automationConfig && scheduleState && (
              <Badge
                variant="outline"
                className={`text-[10px] py-0 ${scheduleState === 'active'
                  ? 'bg-green-500/10 text-green-400 border-green-500/30'
                  : 'bg-muted/20 text-muted-foreground border-border'}`}
              >
                {scheduleState === 'active' ? (
                  <><CheckCircle2 className="w-2.5 h-2.5 mr-1" />Active</>
                ) : (
                  <><XCircle className="w-2.5 h-2.5 mr-1" />Standby</>
                )}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-3">
        {/* Temp row */}
        <div className="flex items-end gap-4">
          <div>
            <p className={`text-3xl font-bold ${style.text}`}>
              {currentTemp !== null ? `${currentTemp}°` : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground">current</p>
          </div>
          {targetTemp !== null && (
            <div className="mb-1">
              <p className="text-lg font-semibold text-muted-foreground">{targetTemp}°</p>
              <p className="text-[10px] text-muted-foreground">target</p>
            </div>
          )}
          {automationConfig && tempInRange !== null && (
            <div className="mb-1 ml-auto">
              {tempInRange ? (
                <p className="text-xs font-medium text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" />In range
                </p>
              ) : (
                <p className="text-xs font-medium text-destructive flex items-center gap-1">
                  <XCircle className="w-3 h-3" />Out of range
                </p>
              )}
              <p className="text-[10px] text-muted-foreground text-right">{automationConfig.bandLabel}</p>
            </div>
          )}
          {!automationConfig && hvacAction && (
            <div className="mb-1 ml-auto">
              <p className={`text-xs capitalize ${style.text}`}>{hvacAction}</p>
              <p className="text-[10px] text-muted-foreground">action</p>
            </div>
          )}
        </div>

        {/* Sparkline — only if we have history */}
        {sparkData.length >= 2 ? (
          <MiniSparkline data={sparkData} mode={hvacMode} />
        ) : (
          <div className="h-[52px] flex items-center justify-center">
            <p className="text-[10px] text-muted-foreground">History populates every 15 min</p>
          </div>
        )}

        {/* Last updated */}
        {lastUpdated && (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {isLive ? 'Live · ' : ''}Updated {lastUpdated}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── AV Closet Card (persistent sensor card) ──────────────────────────────────
// The AV Closet is a Govee H5103 temperature *sensor*, not a climate thermostat,
// so it has no target/mode and never appears in the climate poll. This card is
// always rendered: it shows the live reading once HA discovers the sensor, and a
// clear "Not connected yet" placeholder (with thresholds) until then.

function AvClosetCard({ logs }: { logs: ThermostatLog[] }) {
  // Value comes straight from Govee (HA double-converts and reports ~155°F).
  const { data: reading } = useAvClosetReading();
  const temp = reading?.tempF != null && Number.isFinite(reading.tempF) ? reading.tempF : NaN;
  const humidity = reading?.humidity != null && Number.isFinite(reading.humidity) ? reading.humidity : NaN;
  const hasHumidity = Number.isFinite(humidity);
  // Treat a Govee-reported offline device (dead battery / lost link) as no reading.
  const isOffline = reading?.online === false;
  const hasReading = Number.isFinite(temp) && !isOffline;
  const unit = '°F';

  const isCritical = hasReading && temp >= AV_CLOSET_CRITICAL_TEMP;
  const isWarn = hasReading && temp >= AV_CLOSET_WARN_TEMP;
  const tempColor = isCritical ? 'text-destructive' : isWarn ? 'text-orange-400' : 'text-blue-400';
  const iconBg = isCritical ? 'bg-destructive/10' : isWarn ? 'bg-orange-500/10' : 'bg-blue-500/10';
  const lineColor = isCritical ? '#f87171' : isWarn ? '#fb923c' : '#60a5fa';

  // Build sparkline data from the logged history (last 12 readings), exactly like
  // the thermostat cards. AV Closet is read-only, so there's no target line.
  const sparkData: SparkPoint[] = logs.slice(-12).map(l => ({
    t: format(new Date(l.logged_at), 'h:mm a'),
    v: l.current_temperature ? parseFloat(l.current_temperature) : null,
    target: null,
  }));

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md" data-testid="card-av-closet">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
              <Thermometer className={`w-4 h-4 ${hasReading ? tempColor : 'text-muted-foreground'}`} />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold leading-tight">AV Closet</CardTitle>
              <p className="text-[10px] text-muted-foreground">Govee H5103 temperature sensor</p>
            </div>
          </div>
          <Badge
            variant="outline"
            className={hasReading
              ? 'text-[10px] py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
              : 'text-[10px] py-0 bg-muted/20 text-muted-foreground border-border'}
            data-testid="badge-av-closet-status"
          >
            {hasReading ? (
              <><Radio className="w-2.5 h-2.5 mr-1" />Live</>
            ) : (
              <><XCircle className="w-2.5 h-2.5 mr-1" />Offline</>
            )}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-3">
        {hasReading ? (
          <>
            <div className="flex items-end gap-4">
              <div>
                <p className={`text-3xl font-bold ${tempColor}`} data-testid="text-av-closet-temp">
                  {Math.round(temp)}{unit}
                </p>
                <p className="text-[10px] text-muted-foreground">current</p>
              </div>
              {hasHumidity && (
                <div>
                  <p className="text-3xl font-bold text-cyan-400" data-testid="text-av-closet-humidity">
                    {Math.round(humidity)}%
                  </p>
                  <p className="text-[10px] text-muted-foreground">humidity</p>
                </div>
              )}
              {(isWarn || isCritical) && (
                <div className="mb-1 ml-auto">
                  <p className="text-xs font-medium text-destructive flex items-center gap-1">
                    <XCircle className="w-3 h-3" />{isCritical ? 'Critical' : 'High'}
                  </p>
                </div>
              )}
            </div>
            {/* Sparkline — only if we have history */}
            {sparkData.length >= 2 ? (
              <MiniSparkline data={sparkData} mode={null} lineColor={lineColor} />
            ) : (
              <div className="h-[52px] flex items-center justify-center">
                <p className="text-[10px] text-muted-foreground">History populates every 15 min</p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">{AV_CLOSET_THRESHOLD_NOTE}</p>
          </>
        ) : (
          <div className="space-y-2 py-1">
            <p className="text-sm font-medium" data-testid="text-av-closet-placeholder">
              {AV_CLOSET_PLACEHOLDER_TITLE}
            </p>
            <p className="text-xs text-muted-foreground">{AV_CLOSET_PLACEHOLDER_DETAIL}</p>
            <p className="text-[10px] text-muted-foreground">{AV_CLOSET_THRESHOLD_NOTE}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── History Table ─────────────────────────────────────────────────────────────

function HistoryTable({ logs }: { logs: ThermostatLog[] }) {
  const sorted = [...logs].reverse().slice(0, 60);
  const style = modeStyle(null);

  function modeBadge(mode: string | null) {
    const s = modeStyle(mode);
    return `${s.bg} ${s.text} ${s.border}`;
  }

  if (sorted.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Zap className="h-4 w-4 text-muted-foreground" />
          Recent Readings (all thermostats)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2 text-muted-foreground font-medium">Room</th>
                <th className="text-right px-4 py-2 text-muted-foreground font-medium">Current</th>
                <th className="text-right px-4 py-2 text-muted-foreground font-medium">Target</th>
                <th className="text-left px-4 py-2 text-muted-foreground font-medium">Mode</th>
                <th className="text-left px-4 py-2 text-muted-foreground font-medium">Action</th>
                <th className="text-right px-4 py-2 text-muted-foreground font-medium">Logged</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(log => (
                <tr key={log.id} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-2 font-medium">{cleanName(log.friendly_name) || log.entity_id}</td>
                  <td className="px-4 py-2 text-right">
                    {log.current_temperature ? `${parseFloat(log.current_temperature).toFixed(1)}°F` : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {log.target_temperature ? `${parseFloat(log.target_temperature).toFixed(1)}°F` : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant="outline" className={`text-[10px] py-0 ${modeBadge(log.hvac_mode)}`}>
                      {log.hvac_mode ?? '—'}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground capitalize">{log.hvac_action ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-muted-foreground">
                    {format(new Date(log.logged_at), 'M/d h:mm a')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Section ──────────────────────────────────────────────────────────────

export function ThermostatsSection() {
  const { data, isLoading, error } = useQuery<HistoryResponse>({
    queryKey: ['thermostat-history'],
    queryFn: async () => {
      // Fetch descending so the newest rows always come first, avoiding the
      // silent truncation that occurred when ascending + limit dropped recent data.
      // 6-hour window × 4 readings/hr × up to 30 thermostats ≈ 720 rows max.
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const result = await apiClient.dbQuery<ThermostatLog[]>({
        table: 'thermostat_logs',
        select: 'id,entity_id,friendly_name,current_temperature,target_temperature,hvac_mode,hvac_action,logged_at',
        filters: [{ op: 'gte', column: 'logged_at', value: cutoff }],
        order: { column: 'logged_at', ascending: false },
        limit: 1000,
      });
      // Reverse so the array is oldest→newest; sparkline and latest-reading
      // logic (myLogs[myLogs.length - 1]) both expect that ordering.
      const logs: ThermostatLog[] = (result.data ?? []).reverse();
      return { logs, count: logs.length };
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const logs = data?.logs ?? [];

  // Live HA state — short-poll every 30s so cards reflect reality between cron runs.
  const { data: liveData } = useQuery<Record<string, LiveReading>>({
    queryKey: ['thermostat-live'],
    queryFn: async () => {
      const states = await apiClient.invokeFn<HAClimateState[]>('home-assistant-proxy', {
        action: 'get-domain',
        domain: 'climate',
      });
      const fetchedAt = new Date().toISOString();
      const map: Record<string, LiveReading> = {};
      const arr = Array.isArray(states) ? states : [];
      for (const s of arr) {
        const fn = s.attributes?.friendly_name ?? '';
        if (POOL_SPA_RE.test(s.entity_id) || POOL_SPA_RE.test(fn)) continue;
        const cur = s.attributes?.current_temperature;
        const tgt = s.attributes?.temperature;
        const toNum = (v: unknown): number | null => {
          if (v == null) return null;
          const n = typeof v === 'number' ? v : parseFloat(String(v));
          return Number.isFinite(n) ? n : null;
        };
        map[s.entity_id] = {
          friendly_name: fn || null,
          current_temperature: toNum(cur),
          target_temperature: toNum(tgt),
          hvac_mode: s.state ?? null,
          hvac_action: s.attributes?.hvac_action ?? null,
          fetched_at: fetchedAt,
        };
      }
      return map;
    },
    staleTime: 25_000,
    refetchInterval: 30_000,
    retry: 1,
  });
  // AV Closet is a Govee temperature *sensor* (not a climate entity), so it never
  // shows up in the climate-only live poll above. Pull it from the shared HA entity
  // context (real-time websocket). It renders in its own persistent card (always
  // shown, with a placeholder until HA discovers the H5103), so keep it out of the
  // generic climate-card list below to avoid a duplicate.
  const { entities: sensorEntities } = useSharedHAEntities('sensor');
  const avClosetSensor = findAvClosetTempSensor(sensorEntities);
  const avClosetEntityId = avClosetSensor?.entity_id;

  const live: Record<string, LiveReading> = { ...(liveData ?? {}) };

  // Build ordered entity list: Gym first, rest alphabetically by name.
  // Include any live entity even if it has no logs yet, so cards appear immediately.
  const entityIds = [...new Set([...Object.keys(live), ...logs.map(l => l.entity_id)])]
    .filter(id => id !== avClosetEntityId);
  const getName = (id: string) => {
    const liveName = live[id]?.friendly_name;
    const log = logs.find(l => l.entity_id === id);
    return cleanName(liveName ?? log?.friendly_name ?? id);
  };
  // AV Closet logged history: prefer the live entity id; fall back to matching the
  // logged name so the trend still shows when the sensor is momentarily offline.
  const avClosetLogs = logs.filter(l =>
    (avClosetEntityId && l.entity_id === avClosetEntityId) ||
    /closet|h5103|wifi.?thermometer/i.test(`${l.entity_id} ${l.friendly_name ?? ''}`)
  );

  const PINNED = [GYM_ENTITY_ID, THEATER_ENTITY_ID];
  const pinned = PINNED.filter(id => entityIds.includes(id));
  const rest = entityIds
    .filter(id => !PINNED.includes(id))
    .sort((a, b) => getName(a).localeCompare(getName(b)));
  const ordered = [...pinned, ...rest];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="pt-6 pb-6 text-center space-y-2">
          <XCircle className="h-6 w-6 text-destructive mx-auto" />
          <p className="text-sm font-medium">Failed to load thermostat data</p>
          <p className="text-xs text-muted-foreground font-mono">
            {(error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (ordered.length === 0) {
    // Even with no climate thermostat data yet, the AV Closet sensor card is
    // always shown (live reading or "not connected" placeholder).
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <AvClosetCard logs={avClosetLogs} />
        <Card>
          <CardContent className="pt-6 pb-6 text-center space-y-3">
            <div className="w-10 h-10 rounded-xl bg-muted/30 flex items-center justify-center mx-auto">
              <Thermometer className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">Thermostat data not available yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Data appears here after the first cron run (every 15 min).
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {ordered.map(id => (
          <ThermostatCard key={id} entityId={id} logs={logs} live={live[id] ?? null} />
        ))}
        {/* AV Closet (Govee sensor) — always present, value pulled directly from Govee */}
        <AvClosetCard logs={avClosetLogs} />
      </div>

      {/* Raw log table */}
      <HistoryTable logs={logs} />
    </div>
  );
}
