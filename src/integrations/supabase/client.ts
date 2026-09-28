// Always relative — see fetchWithAuth.ts for the rationale. Hard-coding
// to '' prevents the Supabase compatibility shim from making cross-origin
// calls to the Replit backend, which were being blocked by CORS for
// routes like /api/db/query and /api/db/count.
const API_BASE = '';

function resolveUrl(path: string): string {
  return `${API_BASE}${path}`;
}

type FilterOp = { column: string; op: string; value: unknown };

type QueryResult = { data: unknown; error: { message: string; code?: string } | null; count?: number };

class QueryBuilder {
  private table: string;
  private method: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private selectColumns = '*';
  private filters: FilterOp[] = [];
  private orderColumn: string | null = null;
  private orderAsc = true;
  private orderNullsFirst: boolean | null = null;
  private limitCount: number | null = null;
  private singleResult = false;
  private body: unknown = null;

  constructor(table: string) {
    this.table = table;
  }

  select(columns = '*') {
    if (this.method !== 'insert' && this.method !== 'update' && this.method !== 'upsert' && this.method !== 'delete') {
      this.method = 'select';
    }
    this.selectColumns = columns;
    return this;
  }

  insert(data: unknown) {
    this.method = 'insert';
    this.body = data;
    return this;
  }

  update(data: unknown) {
    this.method = 'update';
    this.body = data;
    return this;
  }

  upsert(data: unknown) {
    this.method = 'upsert';
    this.body = data;
    return this;
  }

  delete() {
    this.method = 'delete';
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown) {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }

  gt(column: string, value: unknown) {
    this.filters.push({ column, op: 'gt', value });
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push({ column, op: 'gte', value });
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push({ column, op: 'lt', value });
    return this;
  }

  lte(column: string, value: unknown) {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push({ column, op: 'is', value });
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push({ column, op: 'in', value: values });
    return this;
  }

  ilike(column: string, value: string) {
    this.filters.push({ column, op: 'ilike', value });
    return this;
  }

  contains(column: string, value: unknown) {
    this.filters.push({ column, op: 'contains', value });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.orderColumn = column;
    this.orderAsc = opts?.ascending ?? true;
    this.orderNullsFirst = opts?.nullsFirst ?? null;
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.singleResult = true;
    return this;
  }

  maybeSingle() {
    this.singleResult = true;
    return this;
  }

  async then(resolve: (val: QueryResult) => void, reject?: (err: unknown) => void): Promise<void> {
    try {
      const result = await this.execute();
      resolve(result);
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }

  private async execute(): Promise<QueryResult> {
    try {
      const resp = await fetch(resolveUrl('/api/data/proxy'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table: this.table,
          method: this.method,
          columns: this.selectColumns,
          filters: this.filters,
          orderColumn: this.orderColumn,
          orderAsc: this.orderAsc,
          orderNullsFirst: this.orderNullsFirst,
          limit: this.limitCount,
          single: this.singleResult,
          body: this.body,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ message: resp.statusText }));
        return { data: null, error: { message: (err as { error?: string; message?: string }).error || (err as { message?: string }).message || 'Request failed', code: resp.status.toString() } };
      }

      const data: unknown = await resp.json();
      return { data: this.singleResult ? ((data as unknown[])[0] ?? null) : data, error: null };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: null, error: { message } };
    }
  }
}

class FunctionsClient {
  async invoke(functionName: string, options?: { body?: unknown; headers?: Record<string, string> }) {
    try {
      const resp = await fetch(resolveUrl(`/functions/v1/${functionName}`), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers || {}),
        },
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({ error: resp.statusText }));
        return { data: null, error: { message: (errData as { error?: string }).error || resp.statusText } };
      }

      const data: unknown = await resp.json().catch(() => null);
      return { data, error: null };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: null, error: { message } };
    }
  }
}

export const supabase = {
  from(table: string) {
    return new QueryBuilder(table);
  },
  functions: new FunctionsClient(),
  auth: {
    async getSession() {
      return { data: { session: null }, error: null };
    },
    async getUser() {
      try {
        const resp = await fetch(resolveUrl('/api/auth/me'), { credentials: 'include' });
        if (resp.ok) {
          const data = await resp.json();
          if (data.user) {
            return { data: { user: { id: data.user.userId, email: data.user.email, user_metadata: { display_name: data.user.displayName } } }, error: null };
          }
        }
      } catch { /* network error – return null user */ }
      return { data: { user: null }, error: null };
    },
    onAuthStateChange(_callback: () => void) {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signOut() {
      await fetch(resolveUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
    },
  },
};
