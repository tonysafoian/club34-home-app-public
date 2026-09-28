/**
 * Regression test: Postgres NUMERIC/DECIMAL columns must arrive as JS numbers.
 *
 * History: the grocery page crashed with "g.toFixed is not a function" because
 * node-postgres returns NUMERIC columns as strings by default and the frontend
 * assumed numbers. The fix is a global type parser in server/db.ts
 * (pg.types.setTypeParser for OID 1700) that coerces NUMERIC → number for
 * every pool created from the shared pg module — both the Drizzle path and
 * raw pool.query()/storage.query() paths.
 *
 * This test guards that parser: if someone removes it (or creates a pool
 * before it is registered), these assertions fail loudly instead of prices,
 * kWh totals, gallons, or speed-test values silently reverting to strings.
 *
 * Exit codes: 0 = pass, 2 = cannot run (no DATABASE_URL), 1 = fail.
 */

import { pool } from '../db';
import { storage } from '../storage';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set');
    process.exit(2);
  }

  const checks: Check[] = [];

  // 1. Raw pool.query — NUMERIC literals of varying precision/scale.
  const literal = await pool.query(
    `SELECT 12.34::numeric        AS price,
            0.000001::numeric     AS tiny,
            1234567.8901::numeric(14,4) AS wide,
            NULL::numeric         AS absent,
            'NaN'::numeric        AS notanum`,
  );
  const row = literal.rows[0];
  checks.push({
    name: 'pool.query numeric → number',
    ok: typeof row.price === 'number' && row.price === 12.34,
    detail: `price=${JSON.stringify(row.price)} (${typeof row.price})`,
  });
  checks.push({
    name: 'pool.query small/wide scales → number',
    ok: typeof row.tiny === 'number' && typeof row.wide === 'number' && row.wide === 1234567.8901,
    detail: `tiny=${typeof row.tiny} wide=${JSON.stringify(row.wide)}`,
  });
  checks.push({
    name: 'pool.query NULL numeric stays null',
    ok: row.absent === null,
    detail: `absent=${JSON.stringify(row.absent)}`,
  });
  checks.push({
    name: "pool.query 'NaN' numeric → NaN (not a string)",
    ok: typeof row.notanum === 'number' && Number.isNaN(row.notanum),
    detail: `notanum=${JSON.stringify(row.notanum)} (${typeof row.notanum})`,
  });

  // 2. storage.query path (what most route files use).
  const viaStorage = await storage.query(
    `SELECT 9.99::numeric(10,2) AS unit_price, AVG(v)::numeric AS avg_val
     FROM (VALUES (1), (2)) AS t(v)
     GROUP BY 1`,
  );
  const srow = viaStorage.rows[0];
  checks.push({
    name: 'storage.query numeric + AVG() aggregate → number',
    ok: typeof srow.unit_price === 'number' && srow.unit_price === 9.99 && typeof srow.avg_val === 'number' && srow.avg_val === 1.5,
    detail: `unit_price=${typeof srow.unit_price} avg_val=${JSON.stringify(srow.avg_val)}`,
  });

  // 3. Real table with a NUMERIC column, read through raw SQL the way the
  //    grocery routes do. Roundtrip an insert/select inside a rolled-back
  //    transaction so the test leaves no data behind.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO grocery_staples (name, category, unit_price)
       VALUES ('__numeric_coercion_test__', 'test', 4.56)
       RETURNING unit_price`,
    );
    const up = inserted.rows[0].unit_price;
    checks.push({
      name: 'grocery_staples.unit_price roundtrip → number',
      ok: typeof up === 'number' && up === 4.56,
      detail: `unit_price=${JSON.stringify(up)} (${typeof up})`,
    });
    // .toFixed must work — this is the exact call that crashed the UI.
    checks.push({
      name: 'unit_price.toFixed(2) works',
      ok: typeof up === 'number' && up.toFixed(2) === '4.56',
      detail: `toFixed=${typeof up === 'number' ? up.toFixed(2) : 'n/a'}`,
    });
    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? 'PASS' : 'FAIL';
    if (!c.ok) failed++;
    console.log(`[${mark}] ${c.name} — ${c.detail}`);
  }

  await pool.end();

  if (failed > 0) {
    console.error(`${failed}/${checks.length} numeric coercion checks failed`);
    process.exit(1);
  }
  console.log(`All ${checks.length} numeric coercion checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('numeric-coercion test crashed:', err);
  process.exit(1);
});
