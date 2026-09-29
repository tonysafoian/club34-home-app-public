# Changelog

## 1.0.4

- **Fix**: Automatically generate and persist `JWT_SECRET` / `SESSION_SECRET` on `/data/jwt_secret` in Home Assistant add-on startup, with safe cryptographic fallback in `server/auth.ts` so the server never crashes on missing secrets.

## 1.0.3

- **Fix**: Make `pdf-parse` dynamic with fallback polyfills for DOMMatrix in `server/handlers/whatsapp.ts` so `pdfjs-dist` browser DOM dependencies are never loaded at server startup.

## 1.0.2

- **Fix**: Completely decouple Vite in production bundles by using dynamic module evaluation so `node dist/index.js` never evaluates Vite or Rolldown native bindings at startup.
- **Fix**: Guard `0042_reconcile_remaining_migration_drift.sql` so missing `janus_memory.embedding` is only checked if the `vector` type is installed, preventing migration abort on standard PostgreSQL installations.
- **Fix**: Enable Alpine community repository in `Dockerfile` to reliably install `postgresql-pgvector`.

## 1.0.1

- **Fix**: Decouple static file serving from Vite/Rolldown so runtime production starts cleanly on Alpine / aarch64 without native binding errors.
- **Fix**: Add defensive exception guards around pgvector extension in migrations `0010` and `0045` so Janus boots reliably on standard PostgreSQL without pgvector.
- **Fix**: Include `postgresql16-client` so `psql` and `createdb` utilities are available for embedded database operations.

## 1.0.0

- Initial release of Janus as an official Home Assistant Add-on.
- Native Ingress integration: embed Janus directly into Home Assistant's left sidebar.
- Zero-config Home Assistant API discovery via Supervisor token.
- Embedded PostgreSQL with automatic persistence on `/data/postgres`.
- 1-click Demo / Local Test authentication mode.
