import { storage } from '../storage.js';

export type QueryRow = Record<string, unknown>;

export interface QueryResult<T = QueryRow> {
  rows: T[];
  rowCount: number | null;
}

interface QueryableStorage {
  query: <T = QueryRow>(text: string, params?: unknown[]) => Promise<QueryResult<T>>;
}

export async function query<T = QueryRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return (storage as unknown as QueryableStorage).query<T>(text, params);
}
