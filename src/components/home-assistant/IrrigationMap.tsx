import { useEffect, useRef, useCallback, useState } from 'react';
import { Move, X } from 'lucide-react';
import { CLOCK_DEFS, ValveDef } from '@/lib/irrigation/controllers';
import type { HAEntity } from '@/lib/api/homeAssistant';
import irrigationMapSvg from '../../assets/irrigation-map.svg?raw';

/* ── Label centre-points for each zone (in SVG viewBox units 900×706) ── */
const LABEL_CENTERS: Record<string, [number, number]> = {
  'clock-1-valve-1': [182, 607],
  'clock-1-valve-2': [727, 607],
  'clock-1-valve-3': [372, 610],
  'clock-1-valve-4': [537, 610],
  'clock-1-valve-5': [435, 610],
  'clock-1-valve-6': [470, 610],
  'clock-1-valve-7': [520, 70],
  'clock-1-valve-8': [380, 70],
  'clock-1-valve-9': [615, 493],
  'clock-1-valve-10': [380, 127],
  'clock-1-valve-11': [520, 127],
  'clock-1-valve-12': [450, 31],
  'clock-2-valve-1': [117, 88],
  'clock-2-valve-2': [255, 88],
  'clock-2-valve-3': [172, 257],
  'clock-2-valve-4': [182, 400],
  'clock-2-valve-5': [182, 485],
  'clock-2-valve-6': [615, 257],
  'clock-2-valve-7': [615, 407],
  'clock-2-valve-8': [450, 88],
  'clock-2-valve-9': [852, 330],
  'clock-2-valve-10': [575, 450],
  'clock-3-valve-1': [727, 43],
  'clock-3-valve-2': [752, 180],
  'clock-3-valve-3': [654, 320],
  'clock-3-valve-4': [739, 212],
  'clock-3-valve-5': [821, 320],
  'clock-3-valve-6': [739, 445],
  'clock-3-valve-7': [690, 492],
  'clock-3-valve-8': [852, 492],
  'clock-3-valve-9': [727, 87],
  'clock-3-valve-10': [727, 132],
  'clock-3-valve-11': [790, 492],
};

const CLOCK_ACCENT: Record<number, string> = {
  1: '#22c55e',
  2: '#06b6d4',
  3: '#f59e0b',
};

interface Props {
  entityByValve: Map<string, HAEntity>;
  selectedSvgId: string | null;
  onSelectValve: (valve: ValveDef | null) => void;
  /** Clock/valve definitions with DB name overrides already applied. Defaults to CLOCK_DEFS. */
  clockDefs?: typeof CLOCK_DEFS;
  /** Admin-saved label position overrides keyed by svgId (SVG viewBox units). */
  savedPositions?: Record<string, [number, number]>;
  /** When true, an "Edit labels" toggle appears and badges become draggable. */
  isAdmin?: boolean;
  /** Persist a dragged label position (called on drop). */
  onSavePosition?: (svgId: string, x: number, y: number) => void;
  /** Reset a label back to its LABEL_CENTERS default. */
  onResetPosition?: (svgId: string) => void;
}

export function IrrigationMap({
  entityByValve,
  selectedSvgId,
  onSelectValve,
  clockDefs = CLOCK_DEFS,
  savedPositions,
  isAdmin = false,
  onSavePosition,
  onResetPosition,
}: Props) {
  /* bgRef: the div that receives dangerouslySetInnerHTML — gives us access to the injected SVG DOM */
  const bgRef = useRef<HTMLDivElement>(null);
  /* track the previously selected svgId to restore focus when the panel closes */
  const prevSelectedRef = useRef<string | null>(null);

  /* overlaySvgRef: the decorative label overlay SVG — used to convert client px to viewBox units while dragging */
  const overlaySvgRef = useRef<SVGSVGElement>(null);
  /* Admin label-edit mode + in-flight drag bookkeeping */
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<Record<string, [number, number]>>({});
  const dragRef = useRef<{ svgId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  /** Query a zone element from the injected background SVG */
  const getZoneEl = useCallback((svgId: string): SVGElement | null => {
    return (bgRef.current?.querySelector(`#${svgId}`) as SVGElement | null) ?? null;
  }, []);

  /** Resolve a label's current [x, y]: live draft → admin override → hardcoded default. */
  const resolvePos = useCallback((svgId: string): [number, number] | null => {
    return draft[svgId] ?? savedPositions?.[svgId] ?? LABEL_CENTERS[svgId] ?? null;
  }, [draft, savedPositions]);

  /** Scale factor from rendered client pixels back to the 900×706 viewBox. */
  const clientToSvgScale = useCallback((): { sx: number; sy: number } => {
    const rect = overlaySvgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { sx: 1, sy: 1 };
    return { sx: 900 / rect.width, sy: 706 / rect.height };
  }, []);

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

  const handleLabelPointerDown = useCallback((e: React.PointerEvent<SVGGElement>, svgId: string) => {
    if (!editMode) return;
    e.stopPropagation();
    e.preventDefault();
    const pos = resolvePos(svgId);
    if (!pos) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { svgId, startX: e.clientX, startY: e.clientY, origX: pos[0], origY: pos[1] };
  }, [editMode, resolvePos]);

  const handleLabelPointerMove = useCallback((e: React.PointerEvent<SVGGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const { sx, sy } = clientToSvgScale();
    const nx = clamp(Math.round(d.origX + (e.clientX - d.startX) * sx), 0, 900);
    const ny = clamp(Math.round(d.origY + (e.clientY - d.startY) * sy), 0, 706);
    setDraft(prev => ({ ...prev, [d.svgId]: [nx, ny] }));
  }, [clientToSvgScale]);

  const handleLabelPointerUp = useCallback((e: React.PointerEvent<SVGGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
    const pos = draft[d.svgId];
    if (pos && (pos[0] !== d.origX || pos[1] !== d.origY)) {
      onSavePosition?.(d.svgId, pos[0], pos[1]);
    }
  }, [draft, onSavePosition]);

  const handleReset = useCallback((svgId: string) => {
    setDraft(prev => {
      const next = { ...prev };
      delete next[svgId];
      return next;
    });
    onResetPosition?.(svgId);
  }, [onResetPosition]);

  /* ── Apply per-zone visual styles ── */
  const applyStyles = useCallback(() => {
    for (const clock of clockDefs) {
      for (const valve of clock.valves) {
        const el = getZoneEl(valve.svgId);
        if (!el) continue;
        const entity = entityByValve.get(valve.svgId);
        const isRunning = entity?.state === 'on';
        const isSelected = valve.svgId === selectedSvgId;
        el.style.cursor = 'pointer';
        el.style.transition = 'filter 0.15s, opacity 0.15s';
        if (isSelected) {
          el.style.strokeWidth = '3';
          el.style.stroke = '#fff';
          el.style.filter = `drop-shadow(0 0 7px ${CLOCK_ACCENT[valve.clockId]})`;
          el.style.opacity = '1';
        } else if (isRunning) {
          el.style.strokeWidth = '2';
          el.style.stroke = '#60a5fa';
          el.style.filter = 'drop-shadow(0 0 9px #3b82f6)';
          el.style.opacity = '0.95';
        } else {
          el.style.strokeWidth = '1';
          el.style.stroke = '#000';
          el.style.filter = 'none';
          el.style.opacity = '0.82';
        }
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute(
          'aria-label',
          `${valve.label}, currently ${entity?.state ?? 'not connected'}${isSelected ? ', selected' : ''}`
        );
      }
    }
  }, [entityByValve, selectedSvgId, getZoneEl, clockDefs]);

  /* ── Attach interaction handlers (re-runs when selection/entity state changes) ── */
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const reg = (el: Element, type: string, fn: EventListener) => {
      el.addEventListener(type, fn);
      cleanups.push(() => el.removeEventListener(type, fn));
    };

    for (const clock of clockDefs) {
      for (const valve of clock.valves) {
        const el = getZoneEl(valve.svgId);
        if (!el) continue;

        const handleClick = (e: Event) => {
          e.stopPropagation();
          onSelectValve(selectedSvgId === valve.svgId ? null : valve);
        };
        const handleKeyDown = (e: Event) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Enter' || ke.key === ' ') { e.preventDefault(); handleClick(e); }
          else if (ke.key === 'Escape') onSelectValve(null);
        };
        const handleEnter = () => {
          if (valve.svgId === selectedSvgId) return;
          el.style.opacity = '1';
          el.style.filter = `drop-shadow(0 0 5px ${CLOCK_ACCENT[valve.clockId]})`;
        };
        const handleLeave = () => applyStyles();

        reg(el, 'click', handleClick);
        reg(el, 'keydown', handleKeyDown);
        reg(el, 'mouseenter', handleEnter);
        reg(el, 'mouseleave', handleLeave);
      }
    }

    /* Click on background (non-zone) deselects */
    const bgSvg = bgRef.current?.querySelector('svg');
    if (bgSvg) {
      const deselect = () => onSelectValve(null);
      bgSvg.addEventListener('click', deselect);
      cleanups.push(() => bgSvg.removeEventListener('click', deselect));
    }

    return () => { for (const fn of cleanups) fn(); };
  }, [entityByValve, selectedSvgId, onSelectValve, applyStyles, getZoneEl, clockDefs]);

  /* ── Apply styles whenever dependencies change ── */
  useEffect(() => { applyStyles(); }, [applyStyles]);

  /* ── Focus restoration: when selection clears, return focus to the previously selected zone ── */
  useEffect(() => {
    if (selectedSvgId !== null) {
      prevSelectedRef.current = selectedSvgId;
    } else if (prevSelectedRef.current) {
      const el = getZoneEl(prevSelectedRef.current) as unknown as HTMLElement | null;
      el?.focus();
      prevSelectedRef.current = null;
    }
  }, [selectedSvgId, getZoneEl]);

  /* ── Global Escape key ── */
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onSelectValve(null); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onSelectValve]);

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border border-border bg-[#111]"
      style={{ aspectRatio: '900 / 706' }}
      role="group"
      aria-label="Irrigation zone map — click or press Enter on a zone to view details"
      data-testid="irrigation-map-container"
    >
      {/* Layer 1 — canonical SVG asset with interactive zone elements.
          Zone polygons receive role="button", tabindex, and aria-label via JS, so this
          layer must NOT be aria-hidden. */}
      <div
        ref={bgRef}
        className="absolute inset-0 w-full h-full [&_svg]:w-full [&_svg]:h-full [&_svg]:block"
        dangerouslySetInnerHTML={{ __html: irrigationMapSvg }}
      />

      {/* Layer 2 — decorative text label overlay (aria-hidden: labels are duplicated in aria-label on each zone).
          In admin edit mode each badge becomes a draggable handle to reposition the label. */}
      <svg
        ref={overlaySvgRef}
        viewBox="0 0 900 706"
        className="absolute inset-0 w-full h-full pointer-events-none"
        aria-hidden="true"
      >
        {clockDefs.flatMap(clock =>
          clock.valves.map(valve => {
            const pos = resolvePos(valve.svgId);
            if (!pos) return null;
            const [cx, cy] = pos;
            const entity = entityByValve.get(valve.svgId);
            const isRunning = entity?.state === 'on';
            const shortLabel = `C${valve.clockId}·V${valve.valveNumber}`;
            const bgW = shortLabel.length * 6.6;
            const isMoved = !!(draft[valve.svgId] ?? savedPositions?.[valve.svgId]);
            return (
              <g
                key={valve.svgId}
                onPointerDown={editMode ? (e) => handleLabelPointerDown(e, valve.svgId) : undefined}
                onPointerMove={editMode ? handleLabelPointerMove : undefined}
                onPointerUp={editMode ? handleLabelPointerUp : undefined}
                style={editMode ? { cursor: 'grab', pointerEvents: 'auto', touchAction: 'none' } : undefined}
                data-testid={`label-zone-${valve.svgId}`}
              >
                {editMode && (
                  <rect
                    x={cx - bgW / 2 - 3}
                    y={cy - 11}
                    width={bgW + 6}
                    height={20}
                    rx="4"
                    fill="none"
                    stroke={CLOCK_ACCENT[valve.clockId]}
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                )}
                <rect
                  x={cx - bgW / 2}
                  y={cy - 8}
                  width={bgW}
                  height={14}
                  rx="3"
                  fill={isRunning ? 'rgba(37,99,235,0.75)' : 'rgba(0,0,0,0.58)'}
                />
                <text
                  x={cx}
                  y={cy + 4}
                  textAnchor="middle"
                  fontSize="9"
                  fontFamily="system-ui,sans-serif"
                  fill={isRunning ? '#93c5fd' : '#ffffffcc'}
                  fontWeight="700"
                  letterSpacing="0.3"
                >
                  {shortLabel}
                </text>
                {isRunning && !editMode && (
                  <circle cx={cx + bgW / 2 + 5} cy={cy} r="3.5" fill="#3b82f6" opacity="0.9">
                    <animate attributeName="r" values="2.5;4.5;2.5" dur="1.5s" repeatCount="indefinite"/>
                    <animate attributeName="opacity" values="0.9;0.3;0.9" dur="1.5s" repeatCount="indefinite"/>
                  </circle>
                )}
                {editMode && isMoved && (
                  <g
                    onPointerDown={(e) => { e.stopPropagation(); handleReset(valve.svgId); }}
                    style={{ cursor: 'pointer', pointerEvents: 'auto' }}
                    data-testid={`reset-zone-${valve.svgId}`}
                  >
                    <circle cx={cx + bgW / 2 + 7} cy={cy - 1} r="6" fill="#ef4444" opacity="0.9" />
                    <text
                      x={cx + bgW / 2 + 7}
                      y={cy + 2.5}
                      textAnchor="middle"
                      fontSize="8"
                      fontWeight="700"
                      fill="#fff"
                    >
                      ×
                    </text>
                  </g>
                )}
              </g>
            );
          })
        )}
      </svg>

      {/* Admin-only "Edit labels" toggle */}
      {isAdmin && (
        <button
          type="button"
          onClick={() => setEditMode(m => !m)}
          className={`absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium shadow-sm transition-colors ${
            editMode
              ? 'bg-primary text-primary-foreground'
              : 'bg-black/60 text-white hover:bg-black/75'
          }`}
          data-testid="button-edit-labels"
        >
          {editMode ? <X className="h-3 w-3" /> : <Move className="h-3 w-3" />}
          {editMode ? 'Done' : 'Edit labels'}
        </button>
      )}

      {/* Edit-mode hint */}
      {editMode && (
        <div
          className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-1 text-[11px] text-white/90"
          data-testid="text-edit-hint"
        >
          Drag a badge to reposition · tap × to reset
        </div>
      )}
    </div>
  );
}
