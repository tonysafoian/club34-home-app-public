/**
 * Single source of truth for failed_jobs retry budget. The schema column
 * `failed_jobs.max_attempts` defaults to this value (see migration 0011),
 * and the retry worker in server/routes/admin.ts imports this constant.
 *
 * If you change this, update the schema default in shared/schema.ts and
 * add a migration so existing rows pick up the new budget.
 */
export const FAILED_JOBS_MAX_ATTEMPTS = 5;

/**
 * Backoff schedule in minutes between retry attempts. Indexed by current
 * attempts count. Entries past the end use the last value.
 */
export const FAILED_JOBS_BACKOFF_MINUTES = [5, 10, 20, 40, 80] as const;
