import { query } from '../lib/db.js';
import type { ProfileAuthRow } from '../../shared/dbRows.js';

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function serializeValue(val: any): any {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    // If any element is a non-null object (i.e. this is a JSONB column), use JSON.stringify.
    // Empty arrays and primitive-only arrays (text[], int[]) keep PostgreSQL array literal
    // format `{}` / `{"a","b"}` — JSON.stringify("[]") would break those column types.
    if (val.length > 0 && val.some(v => v !== null && typeof v === 'object')) {
      return JSON.stringify(val);
    }
    const escaped = val.map((v: any) => typeof v === 'string' ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(v));
    return `{${escaped.join(',')}}`;
  }
  if (typeof val === 'object') return JSON.stringify(val);
  return val;
}

type FilterOp = { column: string; op: string; value: any };

class ServerQueryBuilder {
  private table: string;
  private method: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private selectColumns = '*';
  private filters: FilterOp[] = [];
  private orderClauses: { column: string; asc: boolean; nullsFirst?: boolean }[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private singleResult = false;
  private countMode = false;
  private headOnly = false;
  private body: any = null;
  private upsertConflictCol: string | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns = '*', opts?: { count?: string; head?: boolean }) {
    if (this.method !== 'insert' && this.method !== 'update' && this.method !== 'upsert' && this.method !== 'delete') {
      this.method = 'select';
    }
    this.selectColumns = columns;
    if (opts?.count === 'exact') this.countMode = true;
    if (opts?.head === true) {
      this.headOnly = true;
      this.countMode = true;
    }
    return this;
  }

  insert(data: any) {
    this.method = 'insert';
    this.body = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: any) {
    this.method = 'update';
    this.body = data;
    return this;
  }

  upsert(data: any, opts?: { onConflict?: string }) {
    this.method = 'upsert';
    this.body = Array.isArray(data) ? data : [data];
    if (opts?.onConflict) this.upsertConflictCol = opts.onConflict;
    return this;
  }

  delete() {
    this.method = 'delete';
    return this;
  }

  eq(column: string, value: any) { this.filters.push({ column, op: 'eq', value }); return this; }
  neq(column: string, value: any) { this.filters.push({ column, op: 'neq', value }); return this; }
  gt(column: string, value: any) { this.filters.push({ column, op: 'gt', value }); return this; }
  gte(column: string, value: any) { this.filters.push({ column, op: 'gte', value }); return this; }
  lt(column: string, value: any) { this.filters.push({ column, op: 'lt', value }); return this; }
  lte(column: string, value: any) { this.filters.push({ column, op: 'lte', value }); return this; }
  is(column: string, value: any) { this.filters.push({ column, op: 'is', value }); return this; }
  in(column: string, values: any[]) { this.filters.push({ column, op: 'in', value: values }); return this; }
  like(column: string, value: string) { this.filters.push({ column, op: 'like', value }); return this; }
  ilike(column: string, value: string) { this.filters.push({ column, op: 'ilike', value }); return this; }
  contains(column: string, value: any) { this.filters.push({ column, op: 'contains', value }); return this; }
  containedBy(column: string, value: unknown) { this.filters.push({ column, op: 'containedBy', value }); return this; }
  not(column: string, op: string, value: any) { this.filters.push({ column, op: `not_${op}`, value }); return this; }
  or(filterStr: string) {
    this.filters.push({ column: '__or__', op: 'or', value: filterStr });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderClauses.push({ column, asc: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst });
    return this;
  }

  limit(count: number) { this.limitCount = count; return this; }
  range(from: number, to: number) {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }
  single() { this.singleResult = true; return this; }
  maybeSingle() { this.singleResult = true; return this; }

  async then(resolve: (val: any) => void, reject?: (err: any) => void): Promise<void> {
    try {
      const result = await this.execute();
      resolve(result);
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }

  private buildWhere(startIdx = 1): { clause: string; params: any[]; nextIdx: number } {
    const params: any[] = [];
    const clauses: string[] = [];
    let idx = startIdx;

    for (const f of this.filters) {
      if (!COLUMN_RE.test(f.column)) continue;
      switch (f.op) {
        case 'eq': clauses.push(`${f.column} = $${idx}`); params.push(f.value); idx++; break;
        case 'neq': case 'not_eq': clauses.push(`${f.column} != $${idx}`); params.push(f.value); idx++; break;
        case 'gt': clauses.push(`${f.column} > $${idx}`); params.push(f.value); idx++; break;
        case 'gte': clauses.push(`${f.column} >= $${idx}`); params.push(f.value); idx++; break;
        case 'lt': clauses.push(`${f.column} < $${idx}`); params.push(f.value); idx++; break;
        case 'lte': clauses.push(`${f.column} <= $${idx}`); params.push(f.value); idx++; break;
        case 'is':
          if (f.value === null) { clauses.push(`${f.column} IS NULL`); }
          else { clauses.push(`${f.column} IS $${idx}`); params.push(f.value); idx++; }
          break;
        case 'not_is':
          if (f.value === null) { clauses.push(`${f.column} IS NOT NULL`); }
          else { clauses.push(`${f.column} IS NOT $${idx}`); params.push(f.value); idx++; }
          break;
        case 'in': {
          const ph = f.value.map((_: any, i: number) => `$${idx + i}`);
          clauses.push(`${f.column} IN (${ph.join(', ')})`);
          params.push(...f.value);
          idx += f.value.length;
          break;
        }
        case 'not_in': {
          const ph = f.value.map((_: any, i: number) => `$${idx + i}`);
          clauses.push(`${f.column} NOT IN (${ph.join(', ')})`);
          params.push(...f.value);
          idx += f.value.length;
          break;
        }
        case 'like': clauses.push(`${f.column} LIKE $${idx}`); params.push(f.value); idx++; break;
        case 'ilike': clauses.push(`${f.column} ILIKE $${idx}`); params.push(f.value); idx++; break;
        case 'contains': clauses.push(`${f.column} @> $${idx}`); params.push(JSON.stringify(f.value)); idx++; break;
        case 'containedBy': clauses.push(`${f.column} <@ $${idx}`); params.push(JSON.stringify(f.value)); idx++; break;
        case 'or': {
          const parts = (f.value as string).split(',');
          const orClauses: string[] = [];
          for (const part of parts) {
            const segments = part.trim().split('.');
            if (segments.length < 3) continue;
            const col = segments[0];
            const op = segments[1];
            const val = segments.slice(2).join('.');
            if (!COLUMN_RE.test(col)) continue;
            if (op === 'ilike') {
              orClauses.push(`${col} ILIKE $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'eq') {
              orClauses.push(`${col} = $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'neq') {
              orClauses.push(`${col} != $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'gt') {
              orClauses.push(`${col} > $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'gte') {
              orClauses.push(`${col} >= $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'lt') {
              orClauses.push(`${col} < $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'lte') {
              orClauses.push(`${col} <= $${idx}`);
              params.push(val);
              idx++;
            } else if (op === 'is' && val === 'null') {
              orClauses.push(`${col} IS NULL`);
            }
          }
          if (orClauses.length > 0) {
            clauses.push(`(${orClauses.join(' OR ')})`);
          }
          break;
        }
      }
    }

    return { clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params, nextIdx: idx };
  }

  private async execute(): Promise<{ data: any; error: any; count?: number }> {
    try {
      if (this.method === 'select') {
        if (this.headOnly) {
          const { clause, params } = this.buildWhere();
          const { rows } = await query(
            `SELECT COUNT(*) AS count FROM ${this.table}${clause}`,
            params,
          );
          return { data: null, error: null, count: Number(rows[0]?.count ?? 0) };
        }

        let cols = '*';
        if (this.selectColumns && this.selectColumns !== '*') {
          cols = this.selectColumns.split(',').map(c => c.trim()).filter(c => COLUMN_RE.test(c.split('(')[0].replace(/[()]/g, '').trim())).join(', ') || '*';
        }
        let sql = `SELECT ${cols} FROM ${this.table}`;
        const { clause, params, nextIdx } = this.buildWhere();
        sql += clause;
        let idx = nextIdx;

        if (this.orderClauses.length > 0) {
          const ords = this.orderClauses.filter(o => COLUMN_RE.test(o.column)).map(o => {
            const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
            return `${o.column} ${o.asc ? 'ASC' : 'DESC'}${nulls}`;
          });
          if (ords.length > 0) sql += ` ORDER BY ${ords.join(', ')}`;
        }

        if (this.limitCount) {
          sql += ` LIMIT $${idx}`;
          params.push(this.limitCount);
          idx++;
        }
        if (this.offsetCount) {
          sql += ` OFFSET $${idx}`;
          params.push(this.offsetCount);
          idx++;
        }

        const { rows, rowCount } = await query(sql, params);
        const data = this.singleResult ? (rows[0] || null) : rows;
        const result: any = { data, error: null };
        if (this.countMode) result.count = rowCount ?? rows.length;
        return result;
      }

      if (this.method === 'insert') {
        const item = this.body[0];
        const keys = Object.keys(item).filter(k => COLUMN_RE.test(k));
        const values = keys.map(k => serializeValue(item[k]));
        const ph = keys.map((_, i) => `$${i + 1}`);
        const { rows } = await query(
          `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`,
          values
        );
        return { data: this.singleResult ? (rows[0] || null) : rows, error: null };
      }

      if (this.method === 'update') {
        const dataKeys = Object.keys(this.body).filter(k => COLUMN_RE.test(k));
        const setClauses: string[] = [];
        const params: any[] = [];
        let idx = 1;
        for (const key of dataKeys) {
          setClauses.push(`${key} = $${idx}`);
          params.push(serializeValue(this.body[key]));
          idx++;
        }
        const { clause, params: whereParams } = this.buildWhere(idx);
        params.push(...whereParams);
        const { rows } = await query(`UPDATE ${this.table} SET ${setClauses.join(', ')}${clause} RETURNING *`, params);
        return { data: this.singleResult ? (rows[0] || null) : rows, error: null };
      }

      if (this.method === 'upsert') {
        const item = this.body[0];
        const keys = Object.keys(item).filter(k => COLUMN_RE.test(k));
        const values = keys.map(k => serializeValue(item[k]));
        const ph = keys.map((_, i) => `$${i + 1}`);
        const conflictCol = this.upsertConflictCol || (keys.includes('id') ? 'id' : keys[0]);
        const nonConflict = keys.filter(k => k !== conflictCol);
        const updateClauses = nonConflict.map(k => `${k} = EXCLUDED.${k}`);
        const conflictAction = updateClauses.length > 0 ? `DO UPDATE SET ${updateClauses.join(', ')}` : 'DO NOTHING';
        const { rows } = await query(
          `INSERT INTO ${this.table} (${keys.join(', ')}) VALUES (${ph.join(', ')}) ON CONFLICT (${conflictCol}) ${conflictAction} RETURNING *`,
          values
        );
        return { data: this.singleResult ? (rows[0] || null) : rows, error: null };
      }

      if (this.method === 'delete') {
        const { clause, params } = this.buildWhere();
        const { rows } = await query(`DELETE FROM ${this.table}${clause} RETURNING *`, params);
        return { data: this.singleResult ? (rows[0] || null) : rows, error: null };
      }

      return { data: null, error: { message: 'Invalid method' } };
    } catch (e: any) {
      console.error(`[ServerQueryBuilder] ${this.table}.${this.method} error:`, e.message);
      return { data: null, error: { message: e.message } };
    }
  }
}

class ServerAuthAdmin {
  async getUserById(userId: string) {
    const { rows } = await query<ProfileAuthRow>(`SELECT * FROM profiles WHERE user_id = $1 LIMIT 1`, [userId]);
    if (rows.length === 0) return { data: { user: null }, error: null };
    const p = rows[0];
    return {
      data: {
        user: {
          id: p.user_id,
          email: p.email || '',
          user_metadata: { display_name: p.display_name, full_name: p.display_name, avatar_url: p.avatar_url },
        },
      },
      error: null,
    };
  }

  async listUsers() {
    const { rows } = await query(`SELECT * FROM profiles ORDER BY created_at DESC`);
    return {
      data: {
        users: rows.map(p => ({
          id: p.user_id,
          email: p.email || '',
          user_metadata: { display_name: p.display_name, full_name: p.display_name, avatar_url: p.avatar_url },
          created_at: p.created_at,
        })),
      },
      error: null,
    };
  }
}

class ServerStorageBucket {
  constructor(private bucket: string) {}

  async upload(filePath: string, body: any, _options?: { contentType?: string; upsert?: boolean }) {
    try {
      const buffer = Buffer.from(body);

      // Durable, instance-shared storage is the source of truth (autoscale has
      // ephemeral per-instance disk — see server/lib/objectStore.ts).
      const { putObject } = await import("../lib/objectStore.js");
      await putObject(this.bucket, filePath, buffer);

      // Best-effort local cache for same-instance fast reads.
      try {
        const fs = await import("fs");
        const path = await import("path");
        const fullPath = path.join(process.cwd(), "public", this.bucket, filePath);
        await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.promises.writeFile(fullPath, buffer);
        const distPath = path.join(process.cwd(), "dist/public", this.bucket, filePath);
        await fs.promises.mkdir(path.dirname(distPath), { recursive: true });
        await fs.promises.writeFile(distPath, buffer);
      } catch {}

      return { data: { path: filePath }, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  }

  getPublicUrl(filePath: string) {
    // MUST point at the Express backend that serves /storage/* — NOT the
    // user-facing PUBLIC_BASE_URL (example.com is Cloudflare Pages and returns
    // the SPA index.html for /storage/*, which breaks any consumer fetching the
    // raw media URL, e.g. Google Cast audio). Use MEDIA_BASE_URL.
    const baseUrl = process.env.MEDIA_BASE_URL || "https://club34.replit.app";
    return { data: { publicUrl: `${baseUrl.replace(/\/$/, "")}/storage/v1/object/public/${this.bucket}/${filePath}` } };
  }

  async remove(paths: string[]) {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const { deleteObject } = await import("../lib/objectStore.js");
      for (const fp of paths) {
        try {
          await deleteObject(this.bucket, fp);
        } catch (delErr: any) {
          console.warn(`[supabase-compat] durable remove failed for ${this.bucket}/${fp}: ${delErr?.message}`);
        }
        try {
          const p1 = path.join(process.cwd(), "public", this.bucket, fp);
          const p2 = path.join(process.cwd(), "dist/public", this.bucket, fp);
          if (fs.existsSync(p1)) await fs.promises.unlink(p1);
          if (fs.existsSync(p2)) await fs.promises.unlink(p2);
        } catch {}
      }
      return { data: {}, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message } };
    }
  }
}

class ServerStorageClient {
  from(bucket: string) {
    return new ServerStorageBucket(bucket);
  }
}

export interface SupabaseClient {
  from(table: string): ServerQueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }>;
  functions: {
    invoke(name: string, opts?: { body?: unknown }): Promise<{ data: unknown; error: RpcError | null }>;
  };
  auth: {
    admin: ServerAuthAdmin;
    getUser(): Promise<{ data: { user: any }; error: any }>;
  };
  storage: ServerStorageClient;
}

const FN_NAME_RE = /^[a-z_][a-z0-9_]*$/i;
let _cachedServiceClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (_cachedServiceClient) return _cachedServiceClient;
  _cachedServiceClient = {
    from(table: string) {
      return new ServerQueryBuilder(table);
    },
    rpc: callRpc,
    functions: { invoke: invokeEdgeFunction },
    auth: {
      admin: new ServerAuthAdmin(),
      async getUser() {
        return { data: { user: null }, error: null };
      },
    },
    storage: new ServerStorageClient(),
  };
  return _cachedServiceClient;
}

export function createClient(..._args: any[]): SupabaseClient {
  return getServiceClient();
}

/** Call a Postgres function via SELECT with named arguments (supabase-js rpc compat). */
async function callRpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  try {
    if (!FN_NAME_RE.test(fn)) return { data: null, error: { message: `Invalid function name: ${fn}` } };
    const entries = Object.entries(args || {}).filter(([k]) => COLUMN_RE.test(k));
    const params = entries.map(([, v]) => v);
    const argSql = entries.map(([k], i) => `${k} := $${i + 1}`).join(', ');
    const { rows } = await query(`SELECT * FROM ${fn}(${argSql})`, params);
    // Scalar-returning functions come back as [{ <fn>: value }]
    if (rows.length === 1 && rows[0] && Object.keys(rows[0]).length === 1 && fn in rows[0]) {
      return { data: (rows[0] as Record<string, unknown>)[fn], error: null };
    }
    return { data: rows, error: null };
  } catch (e) {
    return { data: null, error: { message: errMessage(e) } };
  }
}

/** Invoke a Supabase Edge Function over HTTP (supabase-js functions.invoke compat). */
async function invokeEdgeFunction(name: string, opts?: { body?: unknown }): Promise<{ data: unknown; error: RpcError | null }> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return { data: null, error: { message: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' } };
  }
  try {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify(opts?.body ?? {}),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) return { data: null, error: { message: `Edge function ${name} failed (${res.status})`, status: res.status, body: data } };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: { message: errMessage(e) } };
  }
}

export interface RpcError {
  message: string;
  status?: number;
  body?: unknown;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
