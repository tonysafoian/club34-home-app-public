// Standard relative API base URL for same-origin requests.
// Supports VITE_API_URL when frontend and backend run on distinct domains.
const API_BASE = import.meta.env.VITE_API_URL || '';

export function resolveApiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  return `${API_BASE}${path}`;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem('auth_token');
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem('auth_token', token);
  } catch { /* ignore: localStorage unavailable */ }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem('auth_token');
  } catch { /* ignore: localStorage unavailable */ }
}

function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchWithAuth(
  url: string,
  options: RequestInit & { body?: string } = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveApiUrl(url), {
      ...options,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
        ...options.headers,
      },
    });

    return response;
  } finally {
    clearTimeout(timeout);
  }
}
