import { apiClient } from '@/lib/apiClient';

type GoogleAuthResponse = {
  success: boolean;
  error?: string;
  url?: string;
  connected?: boolean;
  google_email?: string | null;
  scopes?: string[];
};

type CalendarListResponse = {
  success: boolean;
  error?: string;
  calendars?: Array<{ id: string; summary: string; backgroundColor: string; primary?: boolean }>;
};

type CalendarEventsResponse = {
  success: boolean;
  error?: string;
  events?: Array<{
    id: string;
    summary: string;
    start: { dateTime?: string; date?: string };
    end: { dateTime?: string; date?: string };
    colorId?: string;
    htmlLink?: string;
  }>;
};

type FamilyEventsResponse = {
  success: boolean;
  error?: string;
  familyEvents?: Record<string, CalendarEventsResponse['events']>;
};

async function callGoogleAuth(action: string, extra: Record<string, string> = {}): Promise<GoogleAuthResponse> {
  return apiClient.post<GoogleAuthResponse>('/api/google/auth', { action, ...extra });
}

export async function getGoogleAuthUrl() {
  return callGoogleAuth('authorize');
}

export async function exchangeGoogleCode(code: string) {
  return callGoogleAuth('callback', { code });
}

export async function getGoogleConnectionStatus() {
  return callGoogleAuth('status');
}

export async function disconnectGoogle() {
  return callGoogleAuth('disconnect');
}

export async function refreshGoogleToken() {
  return callGoogleAuth('refresh');
}

export async function listGoogleCalendars(): Promise<CalendarListResponse> {
  return apiClient.post<CalendarListResponse>('/api/google/calendar', { action: 'list-calendars' });
}

export async function listGoogleEvents(calendarId: string, timeMin: string, timeMax: string, maxResults = 250): Promise<CalendarEventsResponse> {
  return apiClient.post<CalendarEventsResponse>('/api/google/calendar', { action: 'list-events', calendarId, timeMin, timeMax, maxResults });
}

export async function listFamilyEvents(timeMin: string, timeMax: string): Promise<FamilyEventsResponse> {
  return apiClient.post<FamilyEventsResponse>('/api/google/calendar', { action: 'list-family-events', timeMin, timeMax });
}

export async function deleteGoogleEvent(calendarId: string, eventId: string): Promise<GoogleAuthResponse> {
  return apiClient.post<GoogleAuthResponse>('/api/google/calendar', { action: 'delete-event', calendarId, eventId });
}
