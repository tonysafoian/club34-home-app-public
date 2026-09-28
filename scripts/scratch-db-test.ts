import dotenv from 'dotenv';
dotenv.config();

import pg from 'pg';

async function main() {
  console.log('Connecting to database using DATABASE_URL...');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not defined in env!');
    return;
  }
  const pool = new pg.Pool({ connectionString });
  try {
    const logsResult = await pool.query(`
      SELECT * FROM system_audit_log 
      ORDER BY created_at DESC 
      LIMIT 20
    `);
    const dbNameRes = await pool.query('SELECT current_database(), inet_server_addr(), inet_client_addr()');
    console.log('--- DATABASE HOST & DETAILS ---');
    console.log(JSON.stringify(dbNameRes.rows, null, 2));

    console.log('--- LATEST 20 AUDIT LOGS ---');
    for (const row of logsResult.rows) {
      console.log(`[${row.created_at}] [${row.channel}] [${row.severity}] [${row.event_type}] ${row.summary}`);
      if (row.status === 'error' || row.detail) {
        console.log('  Detail:', JSON.stringify(row.detail));
      }
    }

  } catch (err) {
    console.error('Error running query:', err);
  } finally {
    await pool.end();
  }
}

main();
