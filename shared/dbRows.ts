// Shared row types for the raw SQL query layer (server/lib/db.ts `query<T>()`).
//
// The pg driver returns rows with snake_case column names exactly as selected,
// so these types intentionally mirror the DB column names — NOT the camelCase
// `$inferSelect` types in shared/schema.ts (those describe rows read through
// Drizzle, which maps names). Keep these in sync with the corresponding
// pgTable definitions in shared/schema.ts as the schema evolves.
//
// timestamptz columns are typed `string` where every consumer treats them as
// ISO strings (the driver may also hand back Date — both feed `new Date()`),
// and `string | Date` where callers explicitly branch on the runtime type.

/** tesla_tokens — the columns the token-refresh flow consumes (schema: teslaTokens). */
export interface TeslaTokenRow {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_expires_at: string;
}

/** tesla_battery_alerts — columns read by the battery monitor (schema: teslaBatteryAlerts). */
export interface TeslaBatteryAlertRow {
  last_alerted_at: string | null;
  details: Record<string, unknown> | null;
  /** numeric column — node-postgres returns numerics as strings; coerce with Number(). */
  last_range_miles: number | string | null;
  alert_active: boolean | null;
}

/** family_automations — enablement/vacation-mode check (schema: familyAutomations). */
export interface AutomationStatusRow {
  id: string;
  is_active: boolean;
}

/** family_automations — enablement + JSON config (schema: familyAutomations). */
export interface AutomationConfigRow extends AutomationStatusRow {
  config: Record<string, unknown> | null;
}

/** profiles — display-name lookup for audit actor attribution (schema: profiles). */
export interface ProfileDisplayNameRow {
  display_name: string | null;
}

/** profiles — the fields consumed by the Supabase-compat auth admin shim (schema: profiles). */
export interface ProfileAuthRow {
  user_id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

/** Any table's created_at timestamptz (e.g. system_audit_log) — driver may return Date or string. */
export interface CreatedAtRow {
  created_at: string | Date;
}
