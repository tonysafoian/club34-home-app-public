import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// node-postgres returns NUMERIC/DECIMAL columns as strings by default (to
// avoid precision loss on arbitrary-precision values). Every consumer in this
// app treats them as JS numbers, and the string form has caused silent UI
// crashes ("g.toFixed is not a function"). Parse them to numbers globally —
// this covers BOTH the Drizzle path and every raw pool.query()/storage.query()
// path, since the parser registry is shared by all pools created from this
// pg module instance.
// OID 1700 = NUMERIC/DECIMAL.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => parseFloat(value));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
