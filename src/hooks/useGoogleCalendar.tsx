import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from './useAuth';
import {
  getGoogleConnectionStatus,
  getGoogleAuthUrl,
  disconnectGoogle,
  listGoogleCalendars,
  listGoogleEvents,
  listFamilyEvents,
} from '@/lib/api/google';
import { toast } from '@/hooks/use-toast';

export function useGoogleConnectionStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['google-connection-status', user?.userId],
    queryFn: async () => {
      const result = await getGoogleConnectionStatus();
      if (!result.success) throw new Error(result.error);
      return result as { success: boolean; connected: boolean; google_email: string | null; scopes: string[] };
    },
    enabled: !!user,
    staleTime: 60_000,
  });
}

// Clear all Google-related caches when user changes
export function useGoogleCacheReset() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const prevUserId = useRef<string | null>(null);

  useEffect(() => {
    if (user?.userId !== prevUserId.current) {
      if (prevUserId.current !== null) {
        // User changed — clear all Google caches
        queryClient.removeQueries({ queryKey: ['google-connection-status'] });
        queryClient.removeQueries({ queryKey: ['google-calendar-events'] });
        queryClient.removeQueries({ queryKey: ['google-calendars'] });
        queryClient.removeQueries({ queryKey: ['family-calendar-events'] });
      }
      prevUserId.current = user?.userId ?? null;
    }

    // Prefetch Google connection status so calendar card doesn't wait
    if (user?.userId) {
      queryClient.prefetchQuery({
        queryKey: ['google-connection-status', user.userId],
        queryFn: async () => {
          const result = await getGoogleConnectionStatus();
          if (!result.success) throw new Error(result.error);
          return result as { success: boolean; connected: boolean; google_email: string | null; scopes: string[] };
        },
        staleTime: 60_000,
      });
    }
  }, [user?.userId, queryClient]);
}

export function useGoogleConnect() {
  return useMutation({
    mutationFn: async () => {
      const result = await getGoogleAuthUrl();
      if (!result.success) throw new Error(result.error);
      // Redirect to Google OAuth
      window.location.href = result.url;
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useGoogleDisconnect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await disconnectGoogle();
      if (!result.success) throw new Error(result.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['google-connection-status'] });
      queryClient.invalidateQueries({ queryKey: ['google-calendars'] });
      queryClient.invalidateQueries({ queryKey: ['google-calendar-events'] });
      toast({ title: 'Google disconnected' });
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useGoogleCalendars() {
  const { data: status } = useGoogleConnectionStatus();
  return useQuery({
    queryKey: ['google-calendars'],
    queryFn: async () => {
      const result = await listGoogleCalendars();
      if (!result.success) throw new Error(result.error);
      return result.calendars as Array<{
        id: string;
        summary: string;
        backgroundColor: string;
        primary?: boolean;
      }>;
    },
    enabled: !!status?.connected,
  });
}

export function useGoogleCalendarEvents(timeMin: string, timeMax: string) {
  const { user } = useAuth();
  const { data: status } = useGoogleConnectionStatus();
  return useQuery({
    queryKey: ['google-calendar-events', user?.userId, timeMin, timeMax],
    queryFn: async () => {
      const result = await listGoogleEvents('primary', timeMin, timeMax);
      if (!result.success) throw new Error(result.error);
      return result.events as Array<{
        id: string;
        summary: string;
        start: { dateTime?: string; date?: string };
        end: { dateTime?: string; date?: string };
        colorId?: string;
        htmlLink?: string;
      }>;
    },
    enabled: !!user && !!status?.connected && !!timeMin && !!timeMax,
    staleTime: 2 * 60_000,
  });
}

export interface FamilyEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
  htmlLink?: string;
}

export interface FamilyEvents {
  tony: FamilyEvent[];
  lana: FamilyEvent[];
  isla: FamilyEvent[];
  emme: FamilyEvent[];
}

export function useFamilyCalendarEvents(timeMin: string, timeMax: string) {
  const { user } = useAuth();
  const { data: status } = useGoogleConnectionStatus();
  return useQuery({
    queryKey: ['family-calendar-events', user?.userId, timeMin, timeMax],
    queryFn: async () => {
      const result = await listFamilyEvents(timeMin, timeMax);
      if (!result.success) throw new Error(result.error);
      return result.familyEvents as FamilyEvents;
    },
    enabled: !!user && !!status?.connected && !!timeMin && !!timeMax,
    staleTime: 2 * 60_000,
  });
}
