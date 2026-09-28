import { resolveApiUrl } from '@/lib/api/fetchWithAuth';

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  timeoutMs?: number;
};

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const { body, timeoutMs = 15000, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutReason = new DOMException(`Request timed out after ${timeoutMs / 1000}s`, 'TimeoutError');
  const timeout = setTimeout(() => controller.abort(timeoutReason), timeoutMs);

  try {
    let authHeader: Record<string, string> = {};
    try {
      const token = localStorage.getItem('auth_token');
      if (token) authHeader = { Authorization: `Bearer ${token}` };
    } catch { /* localStorage unavailable – proceed without auth header */ }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeader,
      ...(fetchOptions.headers as Record<string, string>),
    };

    const response = await fetch(resolveApiUrl(url), {
      ...fetchOptions,
      headers,
      credentials: 'include',
      signal: controller.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      let errorMessage = response.statusText;
      try {
        const errBody = await response.json();
        errorMessage = errBody.error || errBody.message || errorMessage;
      } catch { /* response body not JSON – use statusText */ }
      throw new ApiError(errorMessage, response.status);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(timeoutReason.message, 408);
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new ApiError(err.message, 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function get<T = unknown>(url: string, options?: Omit<RequestOptions, 'body'>) {
  return request<T>(url, { ...options, method: 'GET' });
}

function post<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'body'>) {
  return request<T>(url, { ...options, method: 'POST', body });
}

function patch<T = unknown>(url: string, body?: unknown, options?: Omit<RequestOptions, 'body'>) {
  return request<T>(url, { ...options, method: 'PATCH', body });
}

function del<T = unknown>(url: string, options?: RequestOptions) {
  return request<T>(url, { ...options, method: 'DELETE' });
}

interface DbFilter {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'contains' | 'containedBy';
  value: unknown;
}

interface DbOrder {
  column: string;
  ascending?: boolean;
  nullsFirst?: boolean;
}

interface DbQueryParams {
  table: string;
  select?: string;
  filters?: DbFilter[];
  order?: DbOrder | DbOrder[];
  limit?: number;
  offset?: number;
  single?: boolean;
  count?: boolean;
  head?: boolean;
}

async function dbQuery<T = unknown>(params: DbQueryParams): Promise<{ data: T; count?: number }> {
  return post('/api/db/query', params);
}

async function dbMaybeSingle<T = unknown>(params: Omit<DbQueryParams, 'single'>): Promise<{ data: T | null }> {
  return post('/api/db/maybeSingle', params);
}

async function dbInsert<T = unknown>(table: string, data: unknown, returnData = true): Promise<{ data: T }> {
  return post('/api/db/insert', { table, data, returnData });
}

async function dbUpdate(table: string, data: unknown, filters: DbFilter[]): Promise<{ success: boolean }> {
  return post('/api/db/update', { table, data, filters });
}

async function dbDelete(table: string, filters: DbFilter[]): Promise<{ success: boolean }> {
  return post('/api/db/delete', { table, filters });
}

async function dbCount(table: string, filters?: DbFilter[]): Promise<number> {
  const result = await post<{ count: number }>('/api/db/count', { table, filters });
  return result.count;
}

const FUNCTION_ROUTE_MAP: Record<string, string> = {
  'home-assistant-proxy': '/api/home-assistant',
  'verkada-proxy': '/api/verkada',
  'iaqualink-proxy': '/api/pool',
  'tesla-proxy': '/api/tesla',
  'tesla-setup': '/api/tesla/setup',
  'google-auth': '/api/google/auth',
  'google-calendar-proxy': '/api/google/calendar',
  'google-environment-proxy': '/api/google/environment',
  'notion-proxy': '/api/notion/proxy',
  'notion-webhook': '/api/notion/webhook',
  'janus-chat': '/api/janus/chat',
  'janus-email-poll': '/api/janus/email-poll',
  'janus-whatsapp': '/api/janus/whatsapp',
  'janus-research-worker': '/api/janus/research-worker',
  'janus-media-worker': '/api/janus/media-worker',
  'janus-reminder-dispatch': '/api/janus/reminder-dispatch',
  'janus-email': '/api/janus/email',
  'janus-health-check': '/api/janus/health-check',
  'janus-functional-test': '/api/janus/functional-test',
  'tesla-battery-monitor': '/api/tesla/battery-monitor',
  'weather-dashboard': '/api/weather-dashboard',
  'weather-forecast': '/api/weather-forecast',
  'nba-game-proxy': '/api/nba-game-proxy',
  'firecrawl-search': '/api/firecrawl-search',
  'entertainment-sync': '/api/entertainment-sync',
  'media-sync': '/api/media-sync',
  'showtimes-proxy': '/api/showtimes-proxy',
  'ai-movie-recommender': '/api/ai-movie-recommender',
  'grocery-order': '/api/grocery-order',
  'trip-document-upload': '/api/trip-document-upload',
  'generac-proxy': '/api/generac',
  'elevenlabs-voice': '/api/broadcast/elevenlabs-voice',
  'credential-vault': '/api/credential-vault',
  'suggest-submit': '/api/suggest-submit',
  'sync-soul': '/api/sync-soul',
  'project-share-notify': '/api/project-share-notify',
  'assemble-report': '/api/assemble-report',
};

async function invokeFn<T = unknown>(functionName: string, body?: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> {
  const route = FUNCTION_ROUTE_MAP[functionName] || `/api/${functionName}`;
  return post<T>(route, body, options);
}

async function rawFetch(url: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutReason = new DOMException(`Request timed out after ${timeoutMs / 1000}s`, 'TimeoutError');
  const timeout = setTimeout(() => controller.abort(timeoutReason), timeoutMs);

  let authHeader: Record<string, string> = {};
  try {
    const token = localStorage.getItem('auth_token');
    if (token) authHeader = { Authorization: `Bearer ${token}` };
  } catch { /* localStorage unavailable – proceed without auth header */ }

  try {
    return await fetch(resolveApiUrl(url), {
      ...fetchOptions,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...authHeader,
        ...(fetchOptions.headers as Record<string, string>),
      },
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new ApiError(timeoutReason.message, 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export const apiClient = {
  get,
  post,
  patch,
  del,
  request,
  dbQuery,
  dbMaybeSingle,
  dbInsert,
  dbUpdate,
  dbDelete,
  dbCount,
  invokeFn,
  rawFetch,
};

export { ApiError };
export type { DbFilter, DbOrder, DbQueryParams };
