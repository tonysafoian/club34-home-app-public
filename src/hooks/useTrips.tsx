import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, ApiError } from "@/lib/apiClient";
import { toast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";

const AI_REQUEST_TIMEOUT_MS = 180000;

export interface TransferSegment {
  type: 'pickup' | 'dropoff';
  datetime: string;
  from: string;
  to: string;
  notes?: string;
}

export interface FlightSegment {
  flight_number: string;
  airline: string;
  from: string;
  to: string;
  departure_datetime: string;
  arrival_datetime: string;
  cabin_class: string;
  confirmation_code: string;
}

export interface HotelBooking {
  name: string;
  address: string;
  check_in: string;
  check_out: string;
  room_type: string;
  confirmation_code: string;
}

export interface ItineraryDay {
  date: string;
  activities: string[];
  notes: string;
}

export interface Trip {
  id: string;
  trip_name: string;
  destination: string | null;
  departure_date: string | null;
  return_date: string | null;
  status: string;
  travelers: string[];
  flights: FlightSegment[];
  hotels: HotelBooking[];
  itinerary: ItineraryDay[];
  transfers: TransferSegment[];
  notes: string | null;
  source_email_ids: string[];
  last_scanned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTripInput {
  trip_name: string;
  destination?: string;
  departure_date?: string;
  return_date?: string;
  travelers?: string[];
  notes?: string;
}

export function useTrips() {
  return useQuery({
    queryKey: ["trips"],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Trip[]>({
        table: "trips",
        select: "*",
        filters: [{ column: "deleted_at", op: "is", value: null }],
        order: { column: "departure_date", ascending: true, nullsFirst: false },
      });
      return data || [];
    },
  });
}

export function useCreateTrip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTripInput) => {
      return apiClient.post<{ ok: boolean; id: string }>('/api/trips', input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      toast({ title: "Trip created", description: "Your trip has been added." });
    },
    onError: (error) => {
      toast({ title: "Failed to create trip", description: error.message, variant: "destructive" });
    },
  });
}

export function useUpdateTrip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<Trip> }) => {
      await apiClient.dbUpdate("trips", updates, [
        { column: "id", op: "eq", value: id },
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      toast({ title: "Trip updated", description: "Changes saved successfully." });
    },
    onError: (error) => {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
    },
  });
}

export function useDeleteTrip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.dbDelete("trips", [
        { column: "id", op: "eq", value: id },
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      toast({ title: "Trip deleted" });
    },
    onError: (error) => {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    },
  });
}

export interface ScanProgress {
  type: 'status' | 'progress' | 'complete' | 'error';
  message?: string;
  current_batch?: number;
  total_batches?: number;
  trips_so_far?: number;
  emails_scanned?: number;
  trips_extracted?: number;
  created?: number;
  updated?: number;
  batches_processed?: number;
  error?: string;
}

export function useScanTravelEmails() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [scanProgress, setScanProgress] = useState<string | null>(null);

  const mutationResult = useMutation({
    mutationFn: async (): Promise<ScanProgress> => {
      if (!user) {
        throw new Error('Please sign in to scan emails');
      }

      setScanProgress('Connecting to email scanner…');

      // Fetch SSE ticket (async) before creating the non-async Promise executor
      let url = '/api/travel-email-scanner/stream';
      try {
        const ticketRes = await apiClient.post<{ ticket: string }>('/api/auth/sse-ticket');
        if (ticketRes.ticket) {
          url = `/api/travel-email-scanner/stream?ticket=${encodeURIComponent(ticketRes.ticket)}`;
        }
      } catch (ticketErr: unknown) {
        if (ticketErr instanceof ApiError && (ticketErr.status === 401 || ticketErr.status === 403)) {
          setScanProgress(null);
          throw new Error('Please sign in to scan emails');
        }
        console.warn('[Travel] SSE ticket request failed, falling back to cookie auth:', ticketErr);
      }

      return new Promise<ScanProgress>((resolve, reject) => {
        const evtSource = new EventSource(url, { withCredentials: true });

        evtSource.onmessage = (e) => {
          try {
            const data: ScanProgress = JSON.parse(e.data);
            if (data.type === 'progress') {
              setScanProgress(`Scanning batch ${data.current_batch} of ${data.total_batches}…`);
            } else if (data.type === 'status' && data.message) {
              setScanProgress(data.message);
            } else if (data.type === 'complete') {
              evtSource.close();
              setScanProgress(null);
              resolve(data);
            } else if (data.type === 'error') {
              evtSource.close();
              setScanProgress(null);
              reject(new Error(data.error || 'Scan failed'));
            }
          } catch (err) {
            console.error('[Travel] SSE parse error:', err);
          }
        };

        let errorFired = false;
        evtSource.onerror = () => {
          if (errorFired) return;
          errorFired = true;
          evtSource.close();
          setScanProgress(null);
          reject(new Error('Email scanner connection failed — please try again'));
        };
      });
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      const emailsScanned = data?.emails_scanned ?? 0;
      const tripsExtracted = data?.trips_extracted ?? 0;
      const created = data?.created ?? 0;
      const updated = data?.updated ?? 0;

      if (data?.message) {
        toast({ title: "Email scan complete", description: data.message });
        return;
      }

      if (tripsExtracted === 0) {
        toast({
          title: "Scan complete — no trips found",
          description: `Scanned ${emailsScanned} email${emailsScanned !== 1 ? 's' : ''}. No travel bookings were detected. Try uploading a document directly on an existing trip.`,
        });
        return;
      }

      const parts: string[] = [];
      if (created > 0) parts.push(`${created} trip${created !== 1 ? 's' : ''} created`);
      if (updated > 0) parts.push(`${updated} updated`);
      toast({
        title: "Email scan complete",
        description: `Scanned ${emailsScanned} emails, found ${tripsExtracted} trip${tripsExtracted !== 1 ? 's' : ''} — ${parts.join(', ')}.`,
      });
    },
    onError: (error) => {
      toast({ title: "Scan failed", description: error.message, variant: "destructive" });
    },
  });

  return { ...mutationResult, scanProgress };
}

export function useUploadTripDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      tripId: string;
      documentText?: string;
      documentType?: string;
      base64Content?: string;
      mimeType?: string;
    }) => {
      const data = await apiClient.post<{
        success: boolean;
        error?: string;
        added: { flights: number; hotels: number; transfers: number; itinerary: number };
        calendarEventsCreated: number;
        travelers: string[];
      }>('/api/trip-document-upload', body, { timeoutMs: AI_REQUEST_TIMEOUT_MS });
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["trips"] });
      const parts: string[] = [];
      if (data.added.flights > 0) parts.push(`${data.added.flights} flight${data.added.flights !== 1 ? "s" : ""}`);
      if (data.added.hotels > 0) parts.push(`${data.added.hotels} hotel${data.added.hotels !== 1 ? "s" : ""}`);
      if (data.added.transfers > 0) parts.push(`${data.added.transfers} transfer${data.added.transfers !== 1 ? "s" : ""}`);
      if (data.added.itinerary > 0) parts.push(`${data.added.itinerary} day plan${data.added.itinerary !== 1 ? "s" : ""}`);
      const addedStr = parts.length > 0 ? parts.join(", ") + " added" : "No new segments found";
      const calStr = data.calendarEventsCreated > 0
        ? `. Calendar events created for ${data.travelers.join(", ")}.`
        : "";
      toast({
        title: "Document parsed",
        description: `${addedStr}${calStr}`,
      });
    },
    onError: (error) => {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    },
  });
}
