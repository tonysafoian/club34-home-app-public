import { useState, useRef } from "react";
import { Plane, Hotel, MapPin, Calendar, Users, Edit2, RefreshCw, Plus, Loader2, Car, ArrowRight, Timer, Trash2, CheckCircle2, Clock3, X, ChevronRight, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { useTrips, useScanTravelEmails, useUpdateTrip, useDeleteTrip, useUploadTripDocument, useCreateTrip, type Trip, type TransferSegment, type FlightSegment, type HotelBooking, type ItineraryDay } from "@/hooks/useTrips";
import { useAuth } from "@/hooks/useAuth";
import { format, parseISO, differenceInDays, isPast } from "date-fns";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtDate(d: string | null | undefined): string {
  if (!d) return "TBD";
  try { return format(parseISO(d), "MMM d, yyyy"); } catch { return d; }
}

function fmtDateShort(d: string | null | undefined): string {
  if (!d) return "TBD";
  try { return format(parseISO(d), "MMM d"); } catch { return d; }
}

function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "TBD";
  try { return format(parseISO(d), "MMM d · h:mm a"); } catch { return d; }
}

function fmtTime(d: string | null | undefined): string {
  if (!d) return "TBD";
  try { return format(parseISO(d), "h:mm a"); } catch { return d; }
}

function getCountdown(departureDate: string | null): { days: number; label: string } | null {
  if (!departureDate) return null;
  try {
    const dept = parseISO(departureDate);
    if (isPast(dept)) return null;
    const days = differenceInDays(dept, new Date());
    if (days === 0) return { days: 0, label: "Today!" };
    if (days === 1) return { days: 1, label: "Tomorrow!" };
    return { days, label: `${days} days` };
  } catch { return null; }
}

function getInitials(name: string): string {
  return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
}

function getDestinationColor(destination: string | null): { from: string; to: string; accent: string } {
  if (!destination) return { from: "from-slate-700", to: "to-slate-900", accent: "bg-slate-500" };
  const d = destination.toLowerCase();
  if (d.includes("mexico") || d.includes("vallarta") || d.includes("cabo") || d.includes("cancun"))
    return { from: "from-amber-600", to: "to-orange-800", accent: "bg-amber-500" };
  if (d.includes("japan") || d.includes("tokyo") || d.includes("kyoto") || d.includes("osaka"))
    return { from: "from-rose-600", to: "to-rose-900", accent: "bg-rose-500" };
  if (d.includes("paris") || d.includes("france") || d.includes("europe"))
    return { from: "from-indigo-600", to: "to-blue-900", accent: "bg-indigo-500" };
  if (d.includes("hawaii") || d.includes("maui") || d.includes("kauai"))
    return { from: "from-teal-500", to: "to-cyan-800", accent: "bg-teal-500" };
  if (d.includes("new york") || d.includes("nyc"))
    return { from: "from-zinc-600", to: "to-zinc-900", accent: "bg-zinc-500" };
  if (d.includes("italy") || d.includes("rome") || d.includes("florence") || d.includes("venice"))
    return { from: "from-green-600", to: "to-emerald-900", accent: "bg-green-500" };
  return { from: "from-primary/80", to: "to-primary", accent: "bg-primary" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline helpers
// ─────────────────────────────────────────────────────────────────────────────

type TimelineItem =
  | { kind: 'transfer'; data: TransferSegment; sortKey: number }
  | { kind: 'flight'; data: FlightSegment; sortKey: number }
  | { kind: 'hotel'; data: HotelBooking; sortKey: number; isCheckOut?: boolean }
  | { kind: 'itinerary'; data: ItineraryDay; sortKey: number };

function buildTimeline(trip: Trip): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const t of trip.transfers || []) {
    try { items.push({ kind: 'transfer', data: t, sortKey: parseISO(t.datetime).getTime() }); } catch { /* ignore: skip unparseable date */ }
  }
  for (const f of trip.flights || []) {
    try { items.push({ kind: 'flight', data: f, sortKey: parseISO(f.departure_datetime).getTime() }); } catch { /* ignore: skip unparseable date */ }
  }
  for (const h of trip.hotels || []) {
    try {
      items.push({ kind: 'hotel', data: h, sortKey: parseISO(h.check_in).getTime() });
      if (h.check_out) items.push({ kind: 'hotel', data: h, sortKey: parseISO(h.check_out).getTime(), isCheckOut: true });
    } catch { /* ignore: skip unparseable date */ }
  }
  for (const day of trip.itinerary || []) {
    try { items.push({ kind: 'itinerary', data: day, sortKey: parseISO(day.date).getTime() }); } catch { /* ignore: skip unparseable date */ }
  }
  return items.sort((a, b) => a.sortKey - b.sortKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline item row
// ─────────────────────────────────────────────────────────────────────────────

function TimelineItemRow({ item }: { item: TimelineItem }) {
  if (item.kind === 'transfer') {
    const t = item.data;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
            <Car className="h-3.5 w-3.5 text-amber-500" />
          </div>
          <div className="w-px flex-1 bg-border/40 mt-1" />
        </div>
        <div className="pb-5 flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-amber-500 uppercase tracking-wider mb-1">
            {t.type === 'pickup' ? 'Pickup' : 'Dropoff'}
          </p>
          <p className="text-sm font-semibold">{t.from} → {t.to}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{fmtDateTime(t.datetime)}</p>
          {t.notes && <p className="text-xs text-muted-foreground/60 mt-1 italic">{t.notes}</p>}
        </div>
      </div>
    );
  }

  if (item.kind === 'flight') {
    const f = item.data;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
            <Plane className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="w-px flex-1 bg-border/40 mt-1" />
        </div>
        <div className="pb-5 flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-primary uppercase tracking-wider mb-1">Flight</p>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold">{f.airline} {f.flight_number}</p>
            {f.cabin_class && <Badge variant="outline" className="text-[10px] h-4 px-1.5">{f.cabin_class}</Badge>}
          </div>
          <div className="flex items-center gap-2 text-sm mt-0.5 font-medium">
            <span>{f.from}</span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span>{f.to}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            <span>Dep {fmtDateTime(f.departure_datetime)}</span>
            {f.arrival_datetime && <><span>·</span><span>Arr {fmtTime(f.arrival_datetime)}</span></>}
          </div>
          {f.confirmation_code && <p className="text-xs text-muted-foreground/60 mt-1 font-mono">Conf: {f.confirmation_code}</p>}
        </div>
      </div>
    );
  }

  if (item.kind === 'hotel') {
    const h = item.data;
    const isCheckOut = item.isCheckOut;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
            <Hotel className="h-3.5 w-3.5 text-purple-400" />
          </div>
          <div className="w-px flex-1 bg-border/40 mt-1" />
        </div>
        <div className="pb-5 flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-purple-400 uppercase tracking-wider mb-1">
            {isCheckOut ? 'Check-out' : 'Check-in'}
          </p>
          <p className="text-sm font-semibold">{h.name}</p>
          {h.room_type && <p className="text-xs text-muted-foreground">{h.room_type}</p>}
          {h.address && <p className="text-xs text-muted-foreground/60 mt-0.5 truncate">{h.address}</p>}
          <p className="text-xs text-muted-foreground mt-0.5">{isCheckOut ? fmtDate(h.check_out) : fmtDate(h.check_in)}</p>
          {h.confirmation_code && !isCheckOut && <p className="text-xs text-muted-foreground/60 mt-1 font-mono">Conf: {h.confirmation_code}</p>}
        </div>
      </div>
    );
  }

  if (item.kind === 'itinerary') {
    const day = item.data;
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-8 h-8 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <Calendar className="h-3.5 w-3.5 text-emerald-500" />
          </div>
          <div className="w-px flex-1 bg-border/40 mt-1" />
        </div>
        <div className="pb-5 flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-emerald-500 uppercase tracking-wider mb-1">Day Plan</p>
          <p className="text-sm font-semibold">{fmtDate(day.date)}</p>
          {day.activities?.map((act, j) => (
            <div key={j} className="flex items-start gap-1.5 text-xs text-muted-foreground mt-0.5">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-emerald-500/60 shrink-0" />
              <span>{act}</span>
            </div>
          ))}
          {day.notes && <p className="text-xs text-muted-foreground/60 mt-1 italic">{day.notes}</p>}
        </div>
      </div>
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boarding pass style flight card (for Flights tab)
// ─────────────────────────────────────────────────────────────────────────────

function BoardingPassCard({ flight }: { flight: FlightSegment }) {
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="bg-primary/5 px-4 py-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-primary">{flight.airline}</span>
        <span className="text-xs font-mono text-muted-foreground">{flight.flight_number}</span>
        {flight.cabin_class && <Badge variant="outline" className="text-[10px] h-4">{flight.cabin_class}</Badge>}
      </div>
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="text-center flex-1">
          <p className="text-2xl font-display font-bold">{flight.from}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{fmtTime(flight.departure_datetime)}</p>
          <p className="text-[11px] text-muted-foreground/70">{fmtDateShort(flight.departure_datetime)}</p>
        </div>
        <div className="flex flex-col items-center gap-1 px-2">
          <Plane className="h-4 w-4 text-primary rotate-90" />
          <div className="w-16 h-px bg-border" />
        </div>
        <div className="text-center flex-1">
          <p className="text-2xl font-display font-bold">{flight.to}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{fmtTime(flight.arrival_datetime)}</p>
          <p className="text-[11px] text-muted-foreground/70">{fmtDateShort(flight.arrival_datetime)}</p>
        </div>
      </div>
      {flight.confirmation_code && (
        <div className="border-t px-4 py-2 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">Confirmation</span>
          <span className="text-xs font-mono font-semibold">{flight.confirmation_code}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotel card (for Hotels tab)
// ─────────────────────────────────────────────────────────────────────────────

function HotelCard({ hotel }: { hotel: HotelBooking }) {
  const nights = hotel.check_in && hotel.check_out
    ? Math.round((new Date(hotel.check_out).getTime() - new Date(hotel.check_in).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="bg-purple-500/5 px-4 py-2 flex items-center gap-2">
        <Hotel className="h-3.5 w-3.5 text-purple-400" />
        <span className="text-sm font-semibold">{hotel.name}</span>
      </div>
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Check-in</p>
            <p className="font-medium">{fmtDate(hotel.check_in)}</p>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <div className="text-right">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Check-out</p>
            <p className="font-medium">{fmtDate(hotel.check_out)}</p>
          </div>
        </div>
        {nights !== null && (
          <p className="text-xs text-muted-foreground">{nights} night{nights !== 1 ? 's' : ''}</p>
        )}
        {hotel.room_type && <p className="text-xs text-muted-foreground">{hotel.room_type}</p>}
        {hotel.address && <p className="text-xs text-muted-foreground/60 truncate">{hotel.address}</p>}
        {hotel.confirmation_code && (
          <div className="flex items-center justify-between pt-1 border-t">
            <span className="text-[11px] text-muted-foreground">Confirmation</span>
            <span className="text-xs font-mono font-semibold">{hotel.confirmation_code}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trip Detail Sheet — TripIt-style with tabs
// ─────────────────────────────────────────────────────────────────────────────

function TripDetailSheet({ trip, open, onClose, onEdit }: { trip: Trip; open: boolean; onClose: () => void; onEdit: () => void }) {
  const countdown = getCountdown(trip.departure_date);
  const colors = getDestinationColor(trip.destination);
  const nights = trip.departure_date && trip.return_date
    ? Math.round((new Date(trip.return_date).getTime() - new Date(trip.departure_date).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const timeline = buildTimeline(trip);
  const uploadDoc = useUploadTripDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const isImage = ["png", "jpg", "jpeg", "webp"].includes(ext);
    const isPdf = ext === "pdf";
    const isDocx = ext === "docx";
    const isXlsx = ext === "xlsx";

    try {
      if (isImage || isPdf) {
        // Send as base64 for multimodal AI parsing
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const base64 = btoa(binary);
        uploadDoc.mutate({
          tripId: trip.id,
          base64Content: base64,
          mimeType: file.type || (isPdf ? "application/pdf" : "image/jpeg"),
          documentType: isPdf ? "PDF" : "image",
        });
      } else if (isDocx) {
        const mammoth = await import("mammoth");
        const buffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer: buffer });
        uploadDoc.mutate({ tripId: trip.id, documentText: result.value, documentType: "DOCX" });
      } else if (isXlsx) {
        const { readXlsxToText } = await import("@/lib/xlsxUtils");
        const buffer = await file.arrayBuffer();
        const text = await readXlsxToText(buffer);
        uploadDoc.mutate({ tripId: trip.id, documentText: text, documentType: "XLSX" });
      } else {
        // Plain text
        const text = await file.text();
        uploadDoc.mutate({ tripId: trip.id, documentText: text, documentType: "text" });
      }
    } catch (err) {
      console.error("File processing error:", err);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[95vh] rounded-t-2xl p-0 overflow-hidden flex flex-col">
        {/* Hero header */}
        <div className={`bg-gradient-to-br ${colors.from} ${colors.to} px-5 pt-5 pb-4 shrink-0`}>
          <div className="flex items-start justify-between mb-3">
            <div className="flex-1 min-w-0">
              <p className="text-white/60 text-xs font-medium uppercase tracking-widest mb-1">
                {trip.status === "confirmed" ? "✓ Confirmed" : trip.status === "completed" ? "Completed" : "Draft"}
              </p>
              <h2 className="text-white text-2xl font-display font-bold leading-tight">{trip.trip_name}</h2>
              {trip.destination && (
                <p className="text-white/70 text-sm flex items-center gap-1 mt-1">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />{trip.destination}
                </p>
              )}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-white/70 hover:text-white hover:bg-white/10 shrink-0 -mt-1" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Date + countdown row */}
          <div className="flex items-center gap-3 flex-wrap">
            {countdown && (
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/20 backdrop-blur-sm">
                <Timer className="h-3.5 w-3.5 text-white" />
                <span className="text-white text-sm font-semibold">{countdown.label}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-white/80 text-sm">
              <Calendar className="h-3.5 w-3.5 shrink-0" />
              <span>{fmtDateShort(trip.departure_date)}</span>
              {trip.return_date && <><ArrowRight className="h-3 w-3" /><span>{fmtDateShort(trip.return_date)}</span></>}
              {nights !== null && <span className="text-white/60">· {nights}n</span>}
            </div>
          </div>

          {/* Traveler avatars */}
          {trip.travelers?.length > 0 && (
            <div className="flex items-center gap-1.5 mt-3 flex-wrap">
              {trip.travelers.map((t, i) => (
                <div key={t} className="w-7 h-7 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center border border-white/30"
                  style={{ marginLeft: i > 0 ? '-6px' : '0' }}>
                  <span className="text-white text-[9px] font-bold">{getInitials(t)}</span>
                </div>
              ))}
              <span className="text-white/60 text-xs ml-2">
                {trip.travelers.join(", ")}
              </span>
            </div>
          )}

          {/* Quick stat chips */}
          <div className="flex gap-2 mt-3 flex-wrap">
            {trip.flights?.length > 0 && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 text-white text-xs">
                <Plane className="h-3 w-3" />{trip.flights.length} flight{trip.flights.length !== 1 ? 's' : ''}
              </div>
            )}
            {trip.hotels?.length > 0 && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 text-white text-xs">
                <Hotel className="h-3 w-3" />{trip.hotels.length} hotel{trip.hotels.length !== 1 ? 's' : ''}
              </div>
            )}
            {trip.transfers?.length > 0 && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 text-white text-xs">
                <Car className="h-3 w-3" />{trip.transfers.length} transfer{trip.transfers.length !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="overview" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-4 mt-3 grid grid-cols-5 shrink-0 h-9">
            <TabsTrigger value="overview" className="text-[11px]">Overview</TabsTrigger>
            <TabsTrigger value="flights" className="text-[11px]">Flights</TabsTrigger>
            <TabsTrigger value="hotels" className="text-[11px]">Hotels</TabsTrigger>
            <TabsTrigger value="itinerary" className="text-[11px]">Itinerary</TabsTrigger>
            <TabsTrigger value="notes" className="text-[11px]">Notes</TabsTrigger>
          </TabsList>

          {/* Overview */}
          <TabsContent value="overview" className="flex-1 overflow-hidden mt-0">
            <ScrollArea className="h-full px-4 py-4">
              {timeline.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <Plane className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p>No itinerary details yet.</p>
                  <p className="text-xs mt-1 opacity-70">Upload a document or edit the trip to add details.</p>
                </div>
              ) : (
                <div className="space-y-0">
                  {timeline.map((item, i) => <TimelineItemRow key={i} item={item} />)}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Flights */}
          <TabsContent value="flights" className="flex-1 overflow-hidden mt-0">
            <ScrollArea className="h-full px-4 py-4">
              {!trip.flights?.length ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <Plane className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p>No flights added yet.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {trip.flights.map((f, i) => <BoardingPassCard key={i} flight={f} />)}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Hotels */}
          <TabsContent value="hotels" className="flex-1 overflow-hidden mt-0">
            <ScrollArea className="h-full px-4 py-4">
              {!trip.hotels?.length ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <Hotel className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p>No hotels added yet.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {trip.hotels.map((h, i) => <HotelCard key={i} hotel={h} />)}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Itinerary */}
          <TabsContent value="itinerary" className="flex-1 overflow-hidden mt-0">
            <ScrollArea className="h-full px-4 py-4">
              {!trip.itinerary?.length ? (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <Calendar className="h-10 w-10 mx-auto mb-3 opacity-20" />
                  <p>No day plans added yet.</p>
                </div>
              ) : (
                <div className="space-y-0">
                  {trip.itinerary.map((day, i) => (
                    <TimelineItemRow key={i} item={{ kind: 'itinerary', data: day, sortKey: 0 }} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* Notes */}
          <TabsContent value="notes" className="flex-1 overflow-hidden mt-0">
            <ScrollArea className="h-full px-4 py-4">
              {trip.notes ? (
                <div className="rounded-xl bg-muted/40 border px-4 py-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {trip.notes}
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <p>No notes yet.</p>
                  <p className="text-xs mt-1 opacity-70">Tap Edit to add visa info, reminders, and more.</p>
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>

        {/* Footer actions */}
        <div className="px-4 py-3 border-t bg-background shrink-0 flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadDoc.isPending}
          >
            {uploadDoc.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Parsing…
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload Document
              </>
            )}
          </Button>
          <Button className="flex-1" onClick={() => { onClose(); onEdit(); }}>
            <Edit2 className="h-4 w-4 mr-2" />
            Edit Trip
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit Sheet
// ─────────────────────────────────────────────────────────────────────────────

function TripEditSheet({ trip, open, onClose }: { trip: Trip; open: boolean; onClose: () => void }) {
  const updateTrip = useUpdateTrip();
  const deleteTrip = useDeleteTrip();
  const [form, setForm] = useState({
    trip_name: trip.trip_name,
    destination: trip.destination || "",
    departure_date: trip.departure_date || "",
    return_date: trip.return_date || "",
    status: trip.status,
    travelers: (trip.travelers || []).join(", "),
    notes: trip.notes || "",
  });

  const handleSave = () => {
    updateTrip.mutate({
      id: trip.id,
      updates: {
        trip_name: form.trip_name,
        destination: form.destination || null,
        departure_date: form.departure_date || null,
        return_date: form.return_date || null,
        status: form.status,
        travelers: form.travelers.split(",").map(s => s.trim()).filter(Boolean),
        notes: form.notes || null,
      },
    }, { onSuccess: onClose });
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="overflow-y-auto">
        <div className="pt-6 pb-2 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">Edit Trip</h2>
        </div>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label>Trip Name</Label>
            <Input value={form.trip_name} onChange={e => setForm(f => ({ ...f, trip_name: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Destination</Label>
            <Input value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))} placeholder="e.g. Tokyo, Japan" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Departure</Label>
              <Input type="date" value={form.departure_date} onChange={e => setForm(f => ({ ...f, departure_date: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Return</Label>
              <Input type="date" value={form.return_date} onChange={e => setForm(f => ({ ...f, return_date: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={v => setForm(f => ({ ...f, status: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Travelers (comma-separated)</Label>
            <Input value={form.travelers} onChange={e => setForm(f => ({ ...f, travelers: e.target.value }))} placeholder="Tony, Lana, Emme, Isla" />
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={4} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Visa info, special requirements…" />
          </div>
          <div className="flex gap-2 pt-2">
            <Button className="flex-1" onClick={handleSave} disabled={updateTrip.isPending}>
              {updateTrip.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Save Changes
            </Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>

          {/* Delete */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" className="w-full text-destructive hover:text-destructive hover:bg-destructive/10 gap-2">
                <Trash2 className="h-4 w-4" />
                Delete Trip
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{trip.trip_name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently remove this trip. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => deleteTrip.mutate(trip.id, { onSuccess: onClose })}
                >
                  {deleteTrip.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Create Trip Sheet
// ─────────────────────────────────────────────────────────────────────────────

const FAMILY_MEMBERS = ["Tony", "Lana", "Isla", "Emme"];

function CreateTripSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createTrip = useCreateTrip();
  const [form, setForm] = useState({
    trip_name: "",
    destination: "",
    departure_date: "",
    return_date: "",
    travelers: [] as string[],
    notes: "",
  });

  const toggleTraveler = (name: string) => {
    setForm(f => ({
      ...f,
      travelers: f.travelers.includes(name)
        ? f.travelers.filter(t => t !== name)
        : [...f.travelers, name],
    }));
  };

  const handleCreate = () => {
    if (!form.trip_name.trim()) return;
    createTrip.mutate(
      {
        trip_name: form.trip_name.trim(),
        destination: form.destination.trim() || undefined,
        departure_date: form.departure_date || undefined,
        return_date: form.return_date || undefined,
        travelers: form.travelers.length > 0 ? form.travelers : undefined,
        notes: form.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setForm({ trip_name: "", destination: "", departure_date: "", return_date: "", travelers: [], notes: "" });
          onClose();
        },
      }
    );
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="overflow-y-auto">
        <div className="pt-6 pb-2">
          <h2 className="font-display text-lg font-semibold">Create Trip</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Add a new trip manually</p>
        </div>
        <div className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label>Trip Name *</Label>
            <Input
              data-testid="input-trip-name"
              value={form.trip_name}
              onChange={e => setForm(f => ({ ...f, trip_name: e.target.value }))}
              placeholder="e.g. Japan Spring 2025"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Destination</Label>
            <Input
              data-testid="input-trip-destination"
              value={form.destination}
              onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}
              placeholder="e.g. Tokyo, Japan"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Departure</Label>
              <Input
                data-testid="input-trip-departure"
                type="date"
                value={form.departure_date}
                onChange={e => setForm(f => ({ ...f, departure_date: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Return</Label>
              <Input
                data-testid="input-trip-return"
                type="date"
                value={form.return_date}
                onChange={e => setForm(f => ({ ...f, return_date: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Travelers</Label>
            <div className="flex flex-wrap gap-2">
              {FAMILY_MEMBERS.map(name => (
                <button
                  key={name}
                  data-testid={`toggle-traveler-${name.toLowerCase()}`}
                  type="button"
                  onClick={() => toggleTraveler(name)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
                    form.travelers.includes(name)
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background text-muted-foreground border-border hover:border-primary/50"
                  }`}
                >
                  <div className="w-5 h-5 rounded-full bg-current/20 flex items-center justify-center">
                    <span className="text-[9px] font-bold">{name[0]}</span>
                  </div>
                  {name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea
              data-testid="input-trip-notes"
              rows={3}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Visa info, special requirements…"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              data-testid="button-create-trip-submit"
              className="flex-1"
              onClick={handleCreate}
              disabled={createTrip.isPending || !form.trip_name.trim()}
            >
              {createTrip.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Create Trip
            </Button>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Trip Card — TripIt-inspired
// ─────────────────────────────────────────────────────────────────────────────

function TripCard({ trip }: { trip: Trip }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const countdown = getCountdown(trip.departure_date);
  const colors = getDestinationColor(trip.destination);
  const nights = trip.departure_date && trip.return_date
    ? Math.round((new Date(trip.return_date).getTime() - new Date(trip.departure_date).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <>
      <Card
        className="overflow-hidden cursor-pointer hover:shadow-lg transition-all duration-200 border-0 shadow-sm hover:scale-[1.01]"
        onClick={() => setDetailOpen(true)}
      >
        {/* Gradient hero strip */}
        <div className={`bg-gradient-to-br ${colors.from} ${colors.to} px-4 pt-4 pb-3 relative`}>
          {/* Edit button */}
          <Button
            variant="ghost" size="icon"
            className="absolute top-2 right-2 h-7 w-7 text-white/70 hover:text-white hover:bg-white/10"
            onClick={e => { e.stopPropagation(); setEditOpen(true); }}
          >
            <Edit2 className="h-3.5 w-3.5" />
          </Button>

          {/* Countdown badge */}
          {countdown && (
            <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 mb-2">
              <Timer className="h-3 w-3 text-white" />
              <span className="text-white text-[11px] font-semibold">{countdown.label} away</span>
            </div>
          )}

          {/* Destination */}
          <h4 className="text-white text-lg font-display font-bold leading-tight pr-8">{trip.trip_name}</h4>
          {trip.destination && (
            <p className="text-white/70 text-xs flex items-center gap-1 mt-0.5">
              <MapPin className="h-3 w-3 shrink-0" />{trip.destination}
            </p>
          )}

          {/* Date range */}
          <div className="flex items-center gap-1.5 text-white/70 text-xs mt-2">
            <Calendar className="h-3 w-3 shrink-0" />
            <span>{fmtDateShort(trip.departure_date)}</span>
            {trip.return_date && <><span>–</span><span>{fmtDateShort(trip.return_date)}</span></>}
            {nights !== null && <span className="text-white/50 ml-1">· {nights} nights</span>}
          </div>
        </div>

        {/* Card body */}
        <CardContent className="px-4 py-3 bg-card">
          {/* Travelers */}
          {trip.travelers?.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2.5">
              <div className="flex -space-x-1.5">
                {trip.travelers.slice(0, 4).map((t) => (
                  <div key={t} className={`w-6 h-6 rounded-full ${colors.accent} flex items-center justify-center border-2 border-card`}>
                    <span className="text-white text-[9px] font-bold">{getInitials(t)}</span>
                  </div>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{trip.travelers.join(", ")}</span>
            </div>
          )}

          {/* Stat chips */}
          <div className="flex flex-wrap gap-1.5">
            {trip.flights?.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary/8 text-[11px] text-primary font-medium">
                <Plane className="h-3 w-3" />{trip.flights.length} flight{trip.flights.length !== 1 ? 's' : ''}
              </div>
            )}
            {trip.hotels?.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-purple-500/8 text-[11px] text-purple-400 font-medium">
                <Hotel className="h-3 w-3" />{trip.hotels.length} hotel{trip.hotels.length !== 1 ? 's' : ''}
              </div>
            )}
            {trip.transfers?.length > 0 && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-500/8 text-[11px] text-amber-500 font-medium">
                <Car className="h-3 w-3" />{trip.transfers.length} transfer{trip.transfers.length !== 1 ? 's' : ''}
              </div>
            )}
            {trip.status === "confirmed" && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/8 text-[11px] text-emerald-500 font-medium">
                <CheckCircle2 className="h-3 w-3" />Confirmed
              </div>
            )}
            {trip.status === "draft" && (
              <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-amber-500/8 text-[11px] text-amber-500 font-medium">
                <Clock3 className="h-3 w-3" />Draft
              </div>
            )}
          </div>

          {/* View CTA */}
          <div className="flex items-center justify-end mt-2 text-xs text-muted-foreground/60">
            <span>View details</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </div>
        </CardContent>
      </Card>

      <TripDetailSheet
        trip={trip}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onEdit={() => setEditOpen(true)}
      />
      <TripEditSheet trip={trip} open={editOpen} onClose={() => setEditOpen(false)} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TravelSection
// ─────────────────────────────────────────────────────────────────────────────

export function TravelSection() {
  const { data: trips = [], isLoading } = useTrips();
  const { mutate: scanMutate, isPending: scanPending, scanProgress } = useScanTravelEmails();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);

  const isLoggedIn = !!user;
  const scanLabel = scanProgress ?? (scanPending ? "Scanning…" : (isLoggedIn ? "Scan Emails" : "Sign in to scan"));

  const handleScanClick = () => {
    if (!isLoggedIn) {
      return;
    }
    scanMutate();
  };

  const handleCreateClick = () => {
    if (!isLoggedIn) {
      return;
    }
    setCreateOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plane className="h-4 w-4 text-primary" />
          <h3 className="text-lg font-display font-semibold">Travel</h3>
          {trips.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">{trips.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            data-testid="button-create-trip"
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs h-8"
            onClick={handleCreateClick}
            disabled={!isLoggedIn}
            title={!isLoggedIn ? "Sign in to create a trip" : undefined}
          >
            <Plus className="h-3.5 w-3.5" />
            {isLoggedIn ? "New Trip" : "Sign in"}
          </Button>
          <Button
            data-testid="button-scan-emails"
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs h-8 max-w-[180px] truncate"
            onClick={handleScanClick}
            disabled={scanPending || !isLoggedIn}
            title={!isLoggedIn ? "Sign in to scan emails" : undefined}
          >
            {scanPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              : <RefreshCw className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{scanLabel}</span>
          </Button>
        </div>
      </div>

      {scanPending && scanProgress && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          <span>{scanProgress}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading trips…
        </div>
      ) : trips.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              <Plane className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No trips yet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isLoggedIn
                  ? "Create a trip manually or scan emails to auto-detect upcoming bookings"
                  : "Sign in to create trips and scan emails for travel bookings"}
              </p>
            </div>
            {isLoggedIn ? (
              <div className="flex gap-2 flex-wrap justify-center">
                <Button
                  data-testid="button-create-trip-empty"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Trip
                </Button>
                <Button
                  data-testid="button-scan-emails-empty"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => scanMutate()}
                  disabled={scanPending}
                >
                  {scanPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {scanPending ? (scanProgress ?? "Scanning…") : "Scan Emails"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">Sign in to get started</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {trips.map(trip => (
            <TripCard key={trip.id} trip={trip} />
          ))}
        </div>
      )}

      <CreateTripSheet open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
