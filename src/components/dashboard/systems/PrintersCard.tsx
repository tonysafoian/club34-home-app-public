import { Printer, AlertTriangle, RefreshCw, Box, Thermometer, Clock, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHAEntities } from '@/hooks/useHAEntities';
import { HAEntity } from '@/lib/api/homeAssistant';
import { cn } from '@/lib/utils';

interface PrinterConfig {
  name: string;
  statusEntity: string;
  cartridges: { label: string; entity: string; color: string }[];
  drumEntity?: string;
}

// IPP-based laser printers (HP color + Brother mono). The Brother HL-L2460DW is a
// mono laser added to HA via the IPP integration, which exposes only two entities:
// sensor.brother_hl_l2460dw (status: idle/printing/stopped) and
// sensor.brother_hl_l2460dw_bk (black toner %). No drum sensor exists — Brother's
// IPP implementation does not surface drum life on this model.
const OFFICE_PRINTERS: PrinterConfig[] = [
  {
    name: "Sandra's Office",
    statusEntity: 'sensor.hp_color_laserjet_pro_mfp_3301_2',
    cartridges: [
      { label: 'Black', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge_2', color: '#374151' },
      { label: 'Cyan', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge_2', color: '#06b6d4' },
      { label: 'Magenta', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge_2', color: '#ec4899' },
      { label: 'Yellow', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge_2', color: '#eab308' },
    ],
  },
  {
    name: 'TigerDen',
    statusEntity: 'sensor.hp_color_laserjet_pro_mfp_3301',
    cartridges: [
      { label: 'Black', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge', color: '#374151' },
      { label: 'Cyan', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge', color: '#06b6d4' },
      { label: 'Magenta', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge', color: '#ec4899' },
      { label: 'Yellow', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge', color: '#eab308' },
    ],
  },
  {
    name: "Main Office",
    statusEntity: 'sensor.brother_hl_l2460dw',
    cartridges: [
      { label: 'Black Toner', entity: 'sensor.brother_hl_l2460dw_bk', color: '#374151' },
    ],
    // No drumEntity: IPP does not expose a drum-life marker for the HL-L2460DW.
  },
];

const LOW_THRESHOLD = 20;
const LOW_DRUM_THRESHOLD = 20;

const OFFICE_ERROR_LABELS: Record<string, string> = {
  unavailable: 'Offline — cannot reach printer',
  offline: 'Offline — printer not responding',
  'paper jam': 'Paper Jam — clear paper path',
  'paper out': 'Out of Paper — reload tray',
  'toner low': 'Toner Low — replace soon',
  'toner empty': 'Toner Empty — replace cartridge',
  error: 'Printer Error — check device',
  unknown: 'Status Unknown',
  'door open': 'Door Open — close printer cover',
  'output bin full': 'Output Bin Full — remove printed pages',
  warming: 'Warming Up',
  stopped: 'Stopped — check printer for paper, cover, or toner',
};

function getOfficeErrorMessage(state: string): string | null {
  const s = state.toLowerCase();
  if (s === 'idle' || s === 'printing') return null;
  return OFFICE_ERROR_LABELS[s] || `Unexpected Status: ${state}`;
}

function TonerBar({ label, level, color }: { label: string; level: number; color: string }) {
  const isLow = level >= 0 && level < LOW_THRESHOLD;
  const displayLevel = level < 0 ? 0 : level;
  return (
    <div className="space-y-1" data-testid={`toner-bar-${label.toLowerCase()}`}>
      <div className="flex items-center justify-between text-xs">
        <span className={cn('text-muted-foreground', isLow && 'text-destructive font-medium')}>
          {label}{isLow && ' ⚠'}
        </span>
        <span className="font-medium">{level < 0 ? '—' : `${displayLevel}%`}</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${displayLevel}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function DrumBar({ level }: { level: number }) {
  const isLow = level >= 0 && level < LOW_DRUM_THRESHOLD;
  const displayLevel = level < 0 ? 0 : level;
  return (
    <div className="space-y-1" data-testid="toner-bar-drum">
      <div className="flex items-center justify-between text-xs">
        <span className={cn('text-muted-foreground', isLow && 'text-destructive font-medium')}>
          Drum{isLow && ' ⚠'}
        </span>
        <span className="font-medium">{level < 0 ? '—' : `${displayLevel}%`}</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${displayLevel}%`, backgroundColor: '#6b7280' }}
        />
      </div>
    </div>
  );
}

function ProgressBar({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value}%</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function OfficeStatusBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  if (s === 'idle') return <Badge className="text-xs bg-status-online text-white" data-testid="badge-office-idle">Idle</Badge>;
  if (s === 'printing') return <Badge className="text-xs bg-primary text-primary-foreground" data-testid="badge-office-printing">Printing</Badge>;
  if (s === 'warming') return <Badge className="text-xs bg-yellow-500/20 text-yellow-600" data-testid="badge-office-warming">Warming Up</Badge>;
  if (s === 'unavailable' || s === 'unknown') return <Badge variant="outline" className="text-xs text-muted-foreground" data-testid="badge-office-offline">Offline</Badge>;
  return <Badge variant="destructive" className="text-xs" data-testid="badge-office-error">{state.charAt(0).toUpperCase() + state.slice(1)}</Badge>;
}

function formatTime(minutes: number): string {
  if (minutes < 1) return 'Less than a minute';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function BambuStatusBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  if (s === 'idle' || s === 'standby') return <Badge className="text-xs bg-status-online text-white" data-testid="badge-bambu-idle">Idle</Badge>;
  if (s === 'printing' || s === 'running') return <Badge className="text-xs bg-blue-500 text-white" data-testid="badge-bambu-printing">Printing</Badge>;
  if (s === 'paused') return <Badge className="text-xs bg-yellow-500/20 text-yellow-600" data-testid="badge-bambu-paused">Paused</Badge>;
  if (s === 'finish' || s === 'finished' || s === 'completed') return <Badge className="text-xs bg-green-500/20 text-green-600" data-testid="badge-bambu-finished">Finished</Badge>;
  if (s === 'failed' || s === 'error') return <Badge variant="destructive" className="text-xs" data-testid="badge-bambu-error">Error</Badge>;
  if (s === 'prepare' || s === 'preparing') return <Badge className="text-xs bg-purple-500/20 text-purple-600" data-testid="badge-bambu-preparing">Preparing</Badge>;
  if (s === 'slicing') return <Badge className="text-xs bg-purple-500/20 text-purple-600" data-testid="badge-bambu-slicing">Slicing</Badge>;
  if (s === 'unavailable' || s === 'unknown') return <Badge variant="outline" className="text-xs text-muted-foreground" data-testid="badge-bambu-offline">Offline</Badge>;
  return <Badge variant="outline" className="text-xs" data-testid="badge-bambu-other">{state}</Badge>;
}

interface BambuPrinter {
  name: string;
  prefix: string;
  status: string;
  stage: string;
  progress: number;
  taskName: string;
  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;
  chamberTemp: number;
  remainingTime: number;
  speedProfile: string;
  trayColor: string;
  hasError: boolean;
  errorMessage: string;
  fanSpeed: number;
  wifiSignal: string;
}

const BAMBU_SIGNATURE_SUFFIXES = [
  'print_status', 'current_stage', 'print_progress', 'print_percentage',
  'nozzle_temperature', 'nozzle_temp', 'bed_temperature', 'bed_temp',
  'chamber_temperature', 'chamber_temp', 'remaining_time', 'task_name',
  'speed_profile', 'active_tray', 'active_tray_color',
  'nozzle_target_temperature', 'nozzle_target_temp',
  'bed_target_temperature', 'bed_target_temp',
  'wifi_signal', 'fan_speed', 'hms_errors', 'hms_error',
];

const OFFICE_ENTITY_PREFIXES = ['hp_color_laserjet', 'hl_l2460dw'];

function discoverBambuPrinters(entities: HAEntity[]): BambuPrinter[] {
  const prefixes = new Set<string>();

  for (const e of entities) {
    for (const suffix of BAMBU_SIGNATURE_SUFFIXES) {
      const match = e.entity_id.match(new RegExp(`^sensor\\.(.+?)_${suffix}$`));
      if (match) {
        const prefix = match[1];
        if (!OFFICE_ENTITY_PREFIXES.some(p => prefix.startsWith(p))) {
          prefixes.add(prefix);
        }
        break;
      }
    }
  }

  if (prefixes.size === 0) return [];

  const find = (prefix: string, suffixes: string[]): HAEntity | undefined => {
    for (const suffix of suffixes) {
      const e = entities.find(ent => ent.entity_id === `sensor.${prefix}_${suffix}`);
      if (e) return e;
    }
    return undefined;
  };

  const numVal = (entity: HAEntity | undefined): number => {
    if (!entity) return 0;
    const v = parseFloat(entity.state);
    return isNaN(v) ? 0 : v;
  };

  const strVal = (entity: HAEntity | undefined): string => {
    if (!entity) return '';
    return entity.state === 'unavailable' || entity.state === 'unknown' ? '' : entity.state;
  };

  return Array.from(prefixes).map(prefix => {
    const statusEntity = find(prefix, ['print_status', 'status', 'current_stage', 'stage']);
    const stageEntity = find(prefix, ['current_stage', 'stage', 'print_status']);
    const progressEntity = find(prefix, ['print_percentage', 'print_progress', 'progress']);
    const taskEntity = find(prefix, ['task_name', 'current_task', 'job_name']);
    const nozzleTempEntity = find(prefix, ['nozzle_temperature', 'nozzle_temp']);
    const nozzleTargetEntity = find(prefix, ['nozzle_target_temperature', 'nozzle_target_temp', 'nozzle_target']);
    const bedTempEntity = find(prefix, ['bed_temperature', 'bed_temp']);
    const bedTargetEntity = find(prefix, ['bed_target_temperature', 'bed_target_temp', 'bed_target']);
    const chamberTempEntity = find(prefix, ['chamber_temperature', 'chamber_temp']);
    const remainingEntity = find(prefix, ['remaining_time', 'time_remaining', 'print_remaining_time']);
    const speedEntity = find(prefix, ['speed_profile', 'speed', 'print_speed']);
    const trayColorEntity = find(prefix, ['active_tray_color', 'tray_color', 'filament_color']);
    const fanEntity = find(prefix, ['fan_speed', 'cooling_fan_speed', 'part_fan_speed']);
    const wifiEntity = find(prefix, ['wifi_signal', 'wifi_strength', 'rssi']);
    const hmsEntity = find(prefix, ['hms_errors', 'hms_error']);

    const status = strVal(statusEntity) || 'unknown';
    const errorStates = ['error', 'failed', 'fault'];
    const hmsState = hmsEntity ? hmsEntity.state : '';
    const hasHmsError = hmsState && hmsState !== 'unavailable' && hmsState !== 'unknown' && hmsState !== '0' && hmsState.toLowerCase() !== 'none' && hmsState.toLowerCase() !== 'no error';
    const hasError = errorStates.includes(status.toLowerCase()) || !!hasHmsError;

    let errorMessage = '';
    if (hasError && statusEntity?.attributes) {
      errorMessage = (statusEntity.attributes.error_message || statusEntity.attributes.print_error || statusEntity.attributes.description || '') as string;
    }
    if (!errorMessage && hasHmsError) {
      errorMessage = typeof hmsState === 'string' ? hmsState : 'HMS error detected — check the printer';
    }

    const friendlyName = statusEntity?.attributes?.friendly_name as string || prefix.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const name = friendlyName.replace(/\s*(print status|status|current stage)$/i, '').trim() || 'Bambu Lab';

    return {
      name,
      prefix,
      status,
      stage: strVal(stageEntity) || status,
      progress: numVal(progressEntity),
      taskName: strVal(taskEntity),
      nozzleTemp: numVal(nozzleTempEntity),
      nozzleTarget: numVal(nozzleTargetEntity),
      bedTemp: numVal(bedTempEntity),
      bedTarget: numVal(bedTargetEntity),
      chamberTemp: numVal(chamberTempEntity),
      remainingTime: numVal(remainingEntity),
      speedProfile: strVal(speedEntity),
      trayColor: strVal(trayColorEntity),
      hasError,
      errorMessage,
      fanSpeed: numVal(fanEntity),
      wifiSignal: strVal(wifiEntity),
    };
  });
}

function BambuPrinterCard({ printer }: { printer: BambuPrinter }) {
  const isPrinting = ['printing', 'running'].includes(printer.status.toLowerCase());
  const hasTemps = printer.nozzleTemp > 0 || printer.bedTemp > 0;

  return (
    <div className="space-y-3" data-testid={`bambu-printer-${printer.prefix}`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{printer.name}</span>
        <BambuStatusBadge state={printer.status} />
      </div>

      {printer.hasError && printer.errorMessage && (
        <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-xs" data-testid="bambu-error-message">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{printer.errorMessage}</span>
        </div>
      )}

      {printer.hasError && !printer.errorMessage && (
        <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-xs" data-testid="bambu-error-generic">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>Printer reported an error — check the device</span>
        </div>
      )}

      {isPrinting && (
        <div className="space-y-2">
          {printer.taskName && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Job:</span> {printer.taskName}
            </div>
          )}
          <ProgressBar value={printer.progress} label="Print Progress" color="#3b82f6" />
          {printer.remainingTime > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>{formatTime(printer.remainingTime)} remaining</span>
            </div>
          )}
          {printer.speedProfile && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Speed:</span> {printer.speedProfile}
            </div>
          )}
        </div>
      )}

      {hasTemps && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Thermometer className="h-3 w-3" />
            Temperatures
          </div>
          <div className="grid grid-cols-3 gap-2">
            {printer.nozzleTemp > 0 && (
              <div className="text-center p-1.5 rounded-md bg-muted/50" data-testid="bambu-nozzle-temp">
                <div className="text-[10px] text-muted-foreground">Nozzle</div>
                <div className="text-xs font-semibold">
                  {printer.nozzleTemp}°C
                  {printer.nozzleTarget > 0 && <span className="text-muted-foreground font-normal"> / {printer.nozzleTarget}°C</span>}
                </div>
              </div>
            )}
            {printer.bedTemp > 0 && (
              <div className="text-center p-1.5 rounded-md bg-muted/50" data-testid="bambu-bed-temp">
                <div className="text-[10px] text-muted-foreground">Bed</div>
                <div className="text-xs font-semibold">
                  {printer.bedTemp}°C
                  {printer.bedTarget > 0 && <span className="text-muted-foreground font-normal"> / {printer.bedTarget}°C</span>}
                </div>
              </div>
            )}
            {printer.chamberTemp > 0 && (
              <div className="text-center p-1.5 rounded-md bg-muted/50" data-testid="bambu-chamber-temp">
                <div className="text-[10px] text-muted-foreground">Chamber</div>
                <div className="text-xs font-semibold">{printer.chamberTemp}°C</div>
              </div>
            )}
          </div>
        </div>
      )}

      {printer.trayColor && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Filament:</span> {printer.trayColor}
        </div>
      )}

      {printer.wifiSignal && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">WiFi:</span> {printer.wifiSignal}
          {!isNaN(Number(printer.wifiSignal)) && ' dBm'}
        </div>
      )}
    </div>
  );
}

export function PrintersCard() {
  const { entities, loading, refetch } = useHAEntities();

  const getEntity = (id: string) => entities.find(e => e.entity_id === id);
  const getLevel = (id: string): number => {
    const e = getEntity(id);
    const val = Number(e?.state);
    return isNaN(val) ? -1 : val;
  };

  const hasLowToner = OFFICE_PRINTERS.some(p => {
    const cartridgeLow = p.cartridges.some(c => {
      const l = getLevel(c.entity);
      return l >= 0 && l < LOW_THRESHOLD;
    });
    const drumLow = p.drumEntity ? (() => {
      const l = getLevel(p.drumEntity!);
      return l >= 0 && l < LOW_DRUM_THRESHOLD;
    })() : false;
    return cartridgeLow || drumLow;
  });

  const officeErrors: { printer: string; message: string }[] = [];
  for (const p of OFFICE_PRINTERS) {
    const state = getEntity(p.statusEntity)?.state ?? 'unknown';
    const msg = getOfficeErrorMessage(state);
    if (msg) officeErrors.push({ printer: p.name, message: msg });
  }

  const bambuPrinters = discoverBambuPrinters(entities);
  const hasBambu = bambuPrinters.length > 0;
  const bambuHasIssues = bambuPrinters.some(p => p.hasError);

  const hasAnyIssue = hasLowToner || officeErrors.length > 0 || bambuHasIssues;

  return (
    <Card className="overflow-hidden transition-all duration-300 hover:shadow-lg animate-slide-up" data-testid="card-printers">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/10">
              <Printer className="h-6 w-6 text-primary" />
            </div>
            <div>
              <CardTitle className="text-lg" data-testid="text-printers-title">Printers</CardTitle>
              {hasAnyIssue && (
                <div className="flex items-center gap-1 mt-1 text-destructive text-xs font-medium" data-testid="text-printer-alert">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {officeErrors.length > 0 ? 'Printer issue detected' : hasLowToner ? 'Low toner detected' : 'Print error detected'}
                </div>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => refetch()} className="shrink-0" data-testid="button-refresh-printers">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && entities.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading printer data…</p>
        ) : hasBambu ? (
          <Tabs defaultValue="office" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger value="office" className="flex-1 gap-1.5" data-testid="tab-office-printers">
                <Printer className="h-3.5 w-3.5" />
                Office Printers
                {(hasLowToner || officeErrors.length > 0) && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
              </TabsTrigger>
              <TabsTrigger value="bambu" className="flex-1 gap-1.5" data-testid="tab-bambu-printers">
                <Box className="h-3.5 w-3.5" />
                3D Printer
                {bambuHasIssues && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="office" className="mt-4 space-y-4">
              <OfficePrintersSection printers={OFFICE_PRINTERS} getEntity={getEntity} getLevel={getLevel} errors={officeErrors} />
            </TabsContent>
            <TabsContent value="bambu" className="mt-4 space-y-4">
              {bambuPrinters.map(p => (
                <BambuPrinterCard key={p.prefix} printer={p} />
              ))}
            </TabsContent>
          </Tabs>
        ) : (
          <OfficePrintersSection printers={OFFICE_PRINTERS} getEntity={getEntity} getLevel={getLevel} errors={officeErrors} />
        )}
      </CardContent>
    </Card>
  );
}

function OfficePrintersSection({
  printers,
  getEntity,
  getLevel,
  errors,
}: {
  printers: PrinterConfig[];
  getEntity: (id: string) => HAEntity | undefined;
  getLevel: (id: string) => number;
  errors: { printer: string; message: string }[];
}) {
  return (
    <>
      {errors.length > 0 && (
        <div className="space-y-2">
          {errors.map(err => (
            <div key={err.printer} className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-xs" data-testid={`office-error-${err.printer.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}>
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span><span className="font-medium">{err.printer}:</span> {err.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-5 md:grid-cols-2">
        {printers.map(printer => {
          const state = getEntity(printer.statusEntity)?.state ?? 'unavailable';
          const isNotConnected = state === 'unavailable' || state === 'unknown';
          return (
            <div key={printer.name} className="space-y-3" data-testid={`office-printer-${printer.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{printer.name}</span>
                <OfficeStatusBadge state={state} />
              </div>
              {isNotConnected ? (
                <p className="text-xs text-muted-foreground italic">Not yet connected to Home Assistant</p>
              ) : (
                <div className="space-y-2">
                  {printer.cartridges.map(c => (
                    <TonerBar key={c.entity} label={c.label} level={getLevel(c.entity)} color={c.color} />
                  ))}
                  {printer.drumEntity && (
                    <DrumBar level={getLevel(printer.drumEntity)} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
