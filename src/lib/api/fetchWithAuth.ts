// Always use relative URLs so requests are same-origin:
//   - In production (example.com) requests are proxied to the Replit
//     backend by public/_worker.js, keeping cookies on example.com.
//   - In dev the Express server and Vite are served on the same port,
//     so relative URLs hit the backend directly.
// Setting VITE_API_URL to https://club34.replit.app at build time caused
// the browser to make cross-origin fetches to the backend, which then
// failed CORS preflight on routes like /api/db/query.
const API_BASE = '';

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
