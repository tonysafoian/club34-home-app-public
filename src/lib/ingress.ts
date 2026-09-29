/**
 * Home Assistant Ingress Path Helper
 *
 * When Janus runs as a Home Assistant Add-on with Ingress enabled,
 * requests are routed under `/api/hassio_ingress/<token>/`.
 * This helper detects the Ingress prefix from the window location
 * or the injected server header, allowing React Router and API calls
 * to route transparently.
 */

export function getIngressPath(): string {
  if (typeof window === 'undefined') return '';
  const injected = (window as unknown as { __INGRESS_PATH__?: string }).__INGRESS_PATH__;
  if (injected) return injected.replace(/\/+$/, '');

  const match = window.location.pathname.match(/^(\/api\/hassio_ingress\/[^/]+)/);
  if (match) return match[1];

  return '';
}

export function resolveAppPath(path: string): string {
  const ingress = getIngressPath();
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (ingress && !normalized.startsWith(ingress)) {
    return `${ingress}${normalized}`;
  }
  return normalized;
}
