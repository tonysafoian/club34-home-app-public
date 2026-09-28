// Cloudflare Pages Function (advanced mode)
//
// Why this exists:
//   The `_redirects` proxy rule for /api/* was being shadowed by the
//   static directory `public/api/auth/google/callback/`. CF Pages
//   prefers static files over redirect rules, and the `200!` "force"
//   flag doesn't work for cross-origin proxies. So we handle the
//   proxy in code.
//
// Routes:
//   /api/auth/google/callback  → serve the static handler from /api/auth/google/callback/index.html
//   /api/*                     → proxy to https://club34.replit.app/api/*
//   /ws/*                      → not handled here (WebSockets don't work through Pages Functions cleanly;
//                                clients should connect to wss://club34.replit.app/ws/* directly)
//   /*                         → fall through to static assets (SPA)
//
// Header forwarding:
//   - Pass through Cookie, Authorization, X-Computer-Token, Content-Type, Accept
//   - Override Host to club34.replit.app so the backend's CORS / vhost matching works
//   - Forward the original origin in X-Forwarded-Host for logging

const BACKEND = "https://club34.replit.app";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Static OAuth handler. The static asset is served from a FLAT file
    // (`/oauth-callback.html`) — NOT from a directory — to avoid CF Pages'
    // clean-URL canonicalization. When the asset lives at
    // `/api/auth/google/callback/index.html`, ASSETS.fetch returns a 308
    // redirecting `/index.html` → the directory URL `/api/auth/google/callback/`,
    // which is what the client just requested → infinite 308 loop. Serving a
    // flat .html file at a path CF doesn't auto-canonicalize avoids the loop.
    // Match both no-slash and trailing-slash forms so the worker handles every
    // shape Google might redirect to (and any CF Pages directory auto-308).
    if (
      url.pathname === "/api/auth/google/callback" ||
      url.pathname === "/api/auth/google/callback/"
    ) {
      return env.ASSETS.fetch(
        new Request(new URL("/oauth-callback.html", url), request),
      );
    }

    // Proxy /api/* to Replit backend
    if (url.pathname.startsWith("/api/")) {
      const upstreamUrl = BACKEND + url.pathname + url.search;
      const init = {
        method: request.method,
        headers: new Headers(request.headers),
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        redirect: "manual",
      };
      // Strip CF-injected headers; preserve auth + body content-type
      init.headers.delete("cf-connecting-ip");
      init.headers.delete("cf-ray");
      init.headers.delete("cf-visitor");
      init.headers.set("x-forwarded-host", url.host);
      init.headers.set("x-forwarded-proto", "https");

      const upstream = await fetch(upstreamUrl, init);
      // Copy response, stripping any caching headers the backend might set incorrectly
      const respHeaders = new Headers(upstream.headers);
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });
    }

    // Everything else → static asset / SPA fallback.
    // Explicitly set no-store on the response so browsers and CDN edge nodes
    // never cache the HTML shell (deep links like /admin?section=ball would
    // otherwise be cached referencing hashed chunks that vanish on the next
    // deploy). The _headers file also sets this, but we set it here too because
    // in Pages Functions (advanced mode) _headers may not apply to all worker
    // responses — belt-and-suspenders.
    const assetResponse = await env.ASSETS.fetch(request);
    const contentType = assetResponse.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const headers = new Headers(assetResponse.headers);
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
      });
    }
    return assetResponse;
  },
};
