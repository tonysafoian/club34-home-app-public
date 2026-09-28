#!/usr/bin/env node
import { loadEnv } from './_env.mjs';

loadEnv();

const base = process.env.HA_BASE_URL;
const token = process.env.HA_TOKEN;
if (!base || !token) {
  console.error('Set HA_BASE_URL and HA_TOKEN in tools/browse/.env');
  process.exit(1);
}

const url = base.replace(/\/$/, '') + '/api/';
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token}` },
});

const body = await res.text();
console.log(JSON.stringify(
  { url, status: res.status, ok: res.ok, body: body.slice(0, 500) },
  null,
  2,
));
process.exit(res.ok ? 0 : 1);
