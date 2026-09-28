// Vitest setupFile for the "server" project. Runs before every test
// file's imports execute, so we can stub env vars that gate module-load
// side effects (e.g. server/db.ts throws if DATABASE_URL is unset).
//
// Tests use dependency injection for any real DB / network call, so a
// dummy URL is sufficient — no pool is ever opened.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.NODE_ENV ??= "test";
