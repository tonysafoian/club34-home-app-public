import { Router } from 'express';
import { storage } from '../storage';
import { createClient } from '../utils/supabase.js';
import { GOOGLE_CLIENT_ID } from '../lib/helpers.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { consumeSseTicket } from './auth.js';

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HOME_BASE = process.env.HOME_LOCATION || 'Los Angeles, CA';
const EMAIL_BATCH_SIZE = 15;

async function getFamilyMemberNames(): Promise<string[]> {
  try {
    const db = storage as any;
    const { rows } = await db.query(`SELECT display_name FROM household_members WHERE is_active = true`);
    if (rows && rows.length > 0) return rows.map((r: any) => r.display_name);
  } catch {}
  return ['Primary', 'Family Member'];
}

function fetchT(input: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input as any, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function getAccessToken(saKeyRaw: string, email: string, scope: string): Promise<string> {
  const sa = JSON.parse(saKeyRaw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: sa.client_email, sub: email, scope, aud: sa.token_uri, iat: now, exp: now + 3600 };
  const { createSign } = await import('crypto');
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;
  const r = await fetchT(sa.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} — ${await r.text()}`);
  return (await r.json()).access_token;
}

async function getOAuthGmailToken(): Promise<string | null> {
  try {
    const serviceClient = createClient();
    const { data: rows } = await serviceClient
      .from('google_tokens')
      .select('*')
      .eq('google_email', ADMIN_EMAIL)
      .limit(1);
    const tokenRow = Array.isArray(rows) ? rows[0] : rows;
    if (!tokenRow?.access_token) return null;

    const scopes: string[] = Array.isArray(tokenRow.scopes) ? tokenRow.scopes : [];
    if (!scopes.some((s: string) => s.includes('gmail'))) {
      console.warn('[Travel] OAuth token does not include gmail.readonly scope — Gmail API calls may fail');
      return null;
    }

    const expiresAt = tokenRow.token_expires_at ? new Date(tokenRow.token_expires_at).getTime() : 0;
    if (Date.now() < expiresAt - 60_000) {
      return tokenRow.access_token;
    }

    if (!tokenRow.refresh_token) {
      console.warn('[Travel] OAuth token expired and no refresh token available');
      return null;
    }

    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientSecret) {
      console.warn('[Travel] OAuth token expired and GOOGLE_CLIENT_SECRET not configured for refresh');
      return null;
    }

    const refreshResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: tokenRow.refresh_token,
        grant_type: 'refresh_token',
      }),
    });

    if (!refreshResp.ok) {
      console.error('[Travel] OAuth token refresh failed:', await refreshResp.text());
      return null;
    }

    const refreshData = await refreshResp.json();
    await serviceClient
      .from('google_tokens')
      .update({
        access_token: refreshData.access_token,
        token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
      })
      .eq('user_id', tokenRow.user_id);

    return refreshData.access_token;
  } catch (e) {
    console.error('[Travel] OAuth token retrieval failed:', e);
    return null;
  }
}

class GmailApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'GmailApiError';
  }
}

async function searchMessages(token: string, query: string, maxResults = 200) {
  const allMessages: { id: string }[] = [];
  let pageToken: string | undefined;
  const perPage = Math.min(maxResults, 200);
  while (allMessages.length < maxResults) {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set('maxResults', String(perPage));
    url.searchParams.set('q', query);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      let body = '';
      try { body = await r.text(); } catch { /* ignore */ }
      throw new GmailApiError(r.status, `Gmail API error ${r.status}: ${body.substring(0, 200)}`);
    }
    const data = await r.json();
    const msgs = data.messages || [];
    allMessages.push(...msgs);
    pageToken = data.nextPageToken;
    if (!pageToken || msgs.length === 0) break;
  }
  return allMessages.slice(0, maxResults);
}

async function getMessage(token: string, messageId: string) {
  const r = await fetch(`${GMAIL_API}/messages/${messageId}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

function extractHeader(message: any, name: string): string {
  return (message.payload?.headers || []).find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function extractEmailBody(message: any): string {
  const payload = message.payload;
  if (!payload) return message.snippet || '';
  function findText(part: any): string | null {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      try { return Buffer.from(part.body.data, 'base64url').toString('utf-8'); } catch { return null; }
    }
    if (part.mimeType === 'text/html' && part.body?.data && !part.parts) {
      try { return Buffer.from(part.body.data, 'base64url').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); } catch { return null; }
    }
    if (part.parts) { for (const sub of part.parts) { const f = findText(sub); if (f) return f; } }
    return null;
  }
  return findText(payload) || message.snippet || '';
}

async function extractTripsFromBatch(
  openrouterApiKey: string,
  batch: any[],
  batchIndex: number,
  totalBatches: number,
): Promise<any[]> {
  const today = new Date().toISOString().split('T')[0];
  const emailsText = batch
    .map((e, i) => `--- EMAIL ${i + 1} ---\nID: ${e.id}\nFrom: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\n\n${e.body}`)
    .join('\n\n');

  const familyNames = await getFamilyMemberNames();
  const systemPrompt = `You are a travel data extraction specialist for the household family based in ${HOME_BASE}.
Family members: ${familyNames.join(', ')}.
Today is ${today}.

Given travel-related emails, extract structured trip info. Return a JSON array (not an object) of trips.

Each trip object must have these exact fields:
{
  "trip_name": "string (descriptive name like 'Japan Spring 2025')",
  "destination": "string (city, country)",
  "departure_date": "YYYY-MM-DD or null",
  "return_date": "YYYY-MM-DD or null",
  "travelers": ["array", "of", "names"],
  "flights": [{"flight_number":"","airline":"","from":"","to":"","departure_datetime":"ISO","arrival_datetime":"ISO","cabin_class":"","confirmation_code":""}],
  "hotels": [{"name":"","address":"","check_in":"YYYY-MM-DD","check_out":"YYYY-MM-DD","room_type":"","confirmation_code":""}],
  "itinerary": [],
  "notes": "string"
}

Rules:
- Only extract GENUINE TRAVEL TRIPS (flights, hotels, bookings). Skip newsletters, promotions without real bookings.
- If an email is about a flight booking, extract it as a trip.
- Return ONLY a valid JSON array, no markdown, no explanation.
- If no trips found, return [].`;

  console.log(`[Travel] Processing batch ${batchIndex + 1}/${totalBatches} with ${batch.length} emails`);

  const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${openrouterApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Extract travel trips from these ${batch.length} emails:\n\n${emailsText}` },
      ],
      temperature: 0.1,
    }),
  });

  if (!aiResponse.ok) {
    const errBody = await aiResponse.text().catch(() => '');
    console.error(`[Travel] AI API error for batch ${batchIndex + 1}: HTTP ${aiResponse.status} — ${errBody.substring(0, 200)}`);
    throw new Error(`AI extraction failed: HTTP ${aiResponse.status}`);
  }

  const aiResult = await aiResponse.json();
  const rawContent = aiResult.choices?.[0]?.message?.content || '';
  console.log(`[Travel] Batch ${batchIndex + 1} AI response (${rawContent.length} chars):`, rawContent.substring(0, 500));

  if (!rawContent.trim()) {
    console.warn(`[Travel] Batch ${batchIndex + 1} AI returned empty content`);
    throw new Error('AI extraction returned empty response');
  }

  const cleaned = rawContent.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      console.log(`[Travel] Batch ${batchIndex + 1} extracted ${parsed.length} trip(s)`);
      return parsed;
    }
    if (parsed && typeof parsed === 'object') {
      console.warn(`[Travel] Batch ${batchIndex + 1} returned object instead of array — wrapping`);
      return [parsed];
    }
    console.warn(`[Travel] Batch ${batchIndex + 1} returned unexpected type: ${typeof parsed}`);
    return [];
  } catch (e) {
    console.error(`[Travel] Batch ${batchIndex + 1} JSON parse failed. Raw content:\n${rawContent}`);
    throw new Error('AI extraction returned malformed JSON — could not parse trip data');
  }
}

function deduplicateTrips(trips: any[]): any[] {
  const seen = new Set<string>();
  return trips.filter(trip => {
    const key = `${(trip.destination || '').toLowerCase()}|${trip.departure_date || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

router.get('/api/travel-email-scanner/stream', (req: any, res: any, next: any) => {
  if (req.query.ticket) {
    const userId = consumeSseTicket(req.query.ticket as string);
    if (userId) {
      req.userId = userId;
      req.userRole = 'member';
      console.log(`[Travel] SSE auth via one-time ticket for userId=${userId}`);
      return next();
    }
    console.warn('[Travel] SSE auth: invalid or expired ticket');
    res.status(401).json({ error: 'Invalid or expired SSE ticket' });
    return;
  }
  if (req.query.token && !req.cookies?.auth_token) {
    req.cookies = req.cookies || {};
    req.cookies.auth_token = req.query.token;
  }
  requireAuth(req, res, next);
}, async (req: any, res: any) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendEvent(data: object) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterApiKey) {
      console.error('[Travel] SSE: OPENROUTER_API_KEY not configured');
      throw new Error('OPENROUTER_API_KEY not configured');
    }

    let gmailToken: string | null = null;
    const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (saKeyRaw) {
      try {
        console.log('[Travel] SSE: attempting service account Gmail auth');
        gmailToken = await getAccessToken(saKeyRaw, ADMIN_EMAIL, 'https://www.googleapis.com/auth/gmail.readonly');
        console.log('[Travel] SSE: service account Gmail auth succeeded');
      } catch (saErr) {
        console.warn('[Travel] SSE: service account auth failed, trying OAuth fallback:', saErr);
      }
    } else {
      console.log('[Travel] SSE: GOOGLE_SERVICE_ACCOUNT_KEY not set, trying OAuth fallback');
    }
    if (!gmailToken) {
      console.log('[Travel] SSE: attempting OAuth token retrieval for', ADMIN_EMAIL);
      gmailToken = await getOAuthGmailToken();
      if (gmailToken) {
        console.log('[Travel] SSE: OAuth token retrieved successfully');
      } else {
        console.error('[Travel] SSE: no Gmail token available from any auth method');
      }
    }
    if (!gmailToken) {
      sendEvent({ type: 'error', error: 'No Gmail authentication available. Either configure GOOGLE_SERVICE_ACCOUNT_KEY or connect your Google account via Settings.' });
      return res.end();
    }

    sendEvent({ type: 'status', message: 'Searching for travel emails…' });

    const travelQuery = [
      'subject:flight OR subject:hotel OR subject:booking OR subject:itinerary',
      'OR subject:reservation OR subject:confirmation OR subject:e-ticket',
      'OR from:expedia.com OR from:booking.com OR from:united.com OR from:delta.com',
      'OR from:aa.com OR from:marriott.com OR from:hilton.com OR from:airbnb.com',
      'OR from:viator.com OR from:klook.com OR from:jal.com OR from:ana.co.jp',
      'OR from:hotels.com OR from:hyatt.com OR from:tripadvisor.com',
      'newer_than:180d',
    ].join(' ');

    console.log('[Travel] SSE: sending Gmail search query');
    let messages: any[];
    try {
      messages = await searchMessages(gmailToken, travelQuery, 200);
      console.log(`[Travel] SSE: Gmail API returned ${messages.length} matching messages`);
    } catch (gmailErr: any) {
      console.error('[Travel] SSE: Gmail API search failed:', gmailErr);
      const isAuthError = gmailErr instanceof GmailApiError && (gmailErr.status === 401 || gmailErr.status === 403);
      sendEvent({
        type: 'error',
        error: isAuthError
          ? 'Gmail access was denied. Please reconnect your Google account via Settings.'
          : `Gmail search failed: ${gmailErr.message}`,
      });
      return res.end();
    }

    if (messages.length === 0) {
      console.log('[Travel] SSE: no travel emails found in Gmail');
      sendEvent({ type: 'complete', ok: true, message: 'No travel emails found in the last 180 days', created: 0, updated: 0, emails_scanned: 0, trips_extracted: 0 });
      return res.end();
    }

    sendEvent({ type: 'status', message: `Found ${messages.length} emails — reading content…` });

    const emailContents: any[] = [];
    for (let i = 0; i < messages.length; i++) {
      try {
        const msg = await getMessage(gmailToken, messages[i].id);
        if (!msg) continue;
        const body = extractEmailBody(msg);
        if (body.length < 50) continue;
        emailContents.push({
          id: messages[i].id,
          subject: extractHeader(msg, 'subject'),
          from: extractHeader(msg, 'from'),
          date: extractHeader(msg, 'date'),
          body: body.substring(0, 3000),
        });
      } catch (e) { console.error('[Travel] Error fetching message', messages[i].id, e); }
    }

    console.log(`[Travel] ${emailContents.length} emails with readable content (${messages.length - emailContents.length} skipped)`);

    if (emailContents.length === 0) {
      console.log('[Travel] SSE: found 0 emails with readable content (all skipped due to short body)');
      sendEvent({ type: 'complete', ok: true, message: 'No readable travel email content found', created: 0, updated: 0, emails_scanned: 0, trips_extracted: 0 });
      return res.end();
    }

    const batches: any[][] = [];
    for (let i = 0; i < emailContents.length; i += EMAIL_BATCH_SIZE) {
      batches.push(emailContents.slice(i, i + EMAIL_BATCH_SIZE));
    }

    console.log(`[Travel] Processing ${emailContents.length} emails in ${batches.length} batches of up to ${EMAIL_BATCH_SIZE}`);

    const allExtractedTrips: any[] = [];
    let aiExtractionFailed = false;
    let aiFailureReason = '';
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      sendEvent({
        type: 'progress',
        current_batch: batchIdx + 1,
        total_batches: batches.length,
        trips_so_far: allExtractedTrips.length,
        message: `Scanning batch ${batchIdx + 1} of ${batches.length}…`,
      });
      console.log(`[Travel] SSE: AI extraction — batch ${batchIdx + 1}/${batches.length} (${batches[batchIdx].length} emails)`);
      try {
        const batchTrips = await extractTripsFromBatch(openrouterApiKey, batches[batchIdx], batchIdx, batches.length);
        console.log(`[Travel] SSE: AI extraction — batch ${batchIdx + 1} yielded ${batchTrips.length} trips`);
        allExtractedTrips.push(...batchTrips);
      } catch (aiErr: any) {
        console.error(`[Travel] SSE: AI extraction failed on batch ${batchIdx + 1}:`, aiErr.message);
        aiExtractionFailed = true;
        aiFailureReason = aiErr.message || 'AI extraction failed';
        break;
      }
    }

    if (aiExtractionFailed && allExtractedTrips.length === 0) {
      sendEvent({ type: 'error', error: `Email scanning failed during AI extraction: ${aiFailureReason}` });
      return res.end();
    }

    const extractedTrips = deduplicateTrips(allExtractedTrips);
    console.log(`[Travel] SSE: AI extraction complete — raw: ${allExtractedTrips.length} trips, after dedup: ${extractedTrips.length}${aiExtractionFailed ? ' (partial — AI failed on some batches)' : ''}`);

    sendEvent({ type: 'status', message: `Found ${extractedTrips.length} trip${extractedTrips.length !== 1 ? 's' : ''} — saving…` });

    const db = storage;
    const emailIds = emailContents.map(e => e.id);
    let created = 0, updated = 0;

    for (const trip of extractedTrips) {
      try {
        let existingRow: any = null;
        if (trip.destination && trip.departure_date) {
          const { rows } = await db.query(`SELECT * FROM trips WHERE destination = $1 AND departure_date::date = $2::date LIMIT 1`, [trip.destination, trip.departure_date]);
          existingRow = rows?.[0];
        }
        if (existingRow) {
          await db.query(`UPDATE trips SET last_scanned_at = $1, source_email_ids = $2 WHERE id = $3`, [new Date().toISOString(), JSON.stringify([...(existingRow.source_email_ids || []), ...emailIds]), existingRow.id]);
          updated++;
          console.log(`[Travel] Updated existing trip: ${existingRow.trip_name}`);
        } else {
          let travelIntelNotes = trip.notes || '';
          if (trip.destination && trip.departure_date) {
            try {
              const { fetchTravelIntelligence } = await import('../services/perplexity.js');
              const intel = await fetchTravelIntelligence(
                trip.destination,
                trip.departure_date,
                trip.return_date || trip.departure_date,
              );
              if (intel) {
                travelIntelNotes = [travelIntelNotes, `\n── TRAVEL INTELLIGENCE ──\n${intel}`].filter(Boolean).join('\n\n');
              }
            } catch (e) {
              console.error('[Travel] Perplexity travel intelligence failed:', e);
            }
          }
          await db.query(
            `INSERT INTO trips (trip_name, destination, departure_date, return_date, status, travelers, flights, hotels, itinerary, notes, source_email_ids, last_scanned_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [trip.trip_name, trip.destination, trip.departure_date, trip.return_date, 'draft', JSON.stringify(trip.travelers || []), JSON.stringify(trip.flights || []), JSON.stringify(trip.hotels || []), JSON.stringify(trip.itinerary || []), travelIntelNotes, JSON.stringify(emailIds), new Date().toISOString()]
          );
          created++;
          console.log(`[Travel] Created new trip: ${trip.trip_name} → ${trip.destination}`);
        }
      } catch (e) { console.error('[Travel] Error upserting trip:', trip.trip_name, e); }
    }

    console.log(`[Travel] Scan complete — emails: ${emailContents.length}, trips extracted: ${extractedTrips.length}, created: ${created}, updated: ${updated}`);
    sendEvent({
      type: 'complete',
      ok: true,
      emails_scanned: emailContents.length,
      trips_extracted: extractedTrips.length,
      created,
      updated,
      batches_processed: batches.length,
    });
    res.end();
  } catch (error: any) {
    console.error('[Travel] travel-email-scanner stream error:', error);
    sendEvent({ type: 'error', error: error.message });
    res.end();
  }
});

router.post('/api/travel-email-scanner', requireAuth, (_req: any, res: any) => {
  res.status(410).json({ ok: false, error: 'This endpoint has been replaced. Use GET /api/travel-email-scanner/stream (SSE) for real-time scanning.' });
});

router.post('/api/trips', requireAuth, async (req: any, res: any) => {
  try {
    const { trip_name, destination, departure_date, return_date, travelers, notes } = req.body;
    if (!trip_name) return res.status(400).json({ error: 'trip_name is required' });

    const db = storage;
    const { rows } = await db.query(
      `INSERT INTO trips (trip_name, destination, departure_date, return_date, status, travelers, flights, hotels, itinerary, notes, source_email_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        trip_name,
        destination || null,
        departure_date || null,
        return_date || null,
        'draft',
        JSON.stringify(travelers || []),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([]),
        notes || null,
        JSON.stringify([]),
      ]
    );
    const newTrip = rows?.[0];
    logAudit('travel-planner', {
      category: 'home', event_type: 'trip_created', severity: 'info',
      actor_id: req.user?.userId || 'UNKNOWN', actor_name: req.user?.displayName || req.user?.email || 'UNKNOWN', actor_role: 'user',
      channel: 'web', summary: `New trip created: "${trip_name}"${destination ? ` → ${destination}` : ''}${departure_date ? ` on ${departure_date}` : ''}`,
      detail: { trip_id: newTrip?.id, trip_name, destination, departure_date, return_date, travelers }, status: 'success',
    });
    console.log(`[Travel] Manually created trip: ${trip_name} → ${destination || 'TBD'}`);
    res.json({ ok: true, id: newTrip?.id });
  } catch (error: any) {
    console.error('[Travel] create trip error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function resolveTravelerEmail(name: string): Promise<string | null> {
  const lower = name.toLowerCase().trim();
  try {
    const db = storage as any;
    const { rows } = await db.query(
      `SELECT email FROM household_members WHERE is_active = true AND email IS NOT NULL AND (LOWER(display_name) LIKE $1 OR $2 = ANY(aliases)) LIMIT 1`,
      [`%${lower}%`, lower]
    );
    if (rows && rows[0]?.email) return rows[0].email;
  } catch {}
  return null;
}

router.post('/api/trip-document-upload', requireAuth, async (req: any, res: any) => {
  try {
    const { tripId, documentText, documentType, base64Content, mimeType } = req.body;
    if (!tripId) return res.status(400).json({ error: 'tripId is required' });

    const db = storage;
    const { rows } = await db.query(`SELECT * FROM trips WHERE id = $1`, [tripId]);
    const trip = rows?.[0];
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const openrouterApiKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterApiKey) throw new Error('OPENROUTER_API_KEY not configured');

    const systemPrompt = `You are a travel document parser. Extract structured travel information. Return JSON with: flights, hotels, transfers, itinerary, notes. Return ONLY valid JSON.`;
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    if (base64Content && mimeType) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `Extract travel details from this ${documentType} document.` }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Content}` } }] });
    } else if (documentText) {
      messages.push({ role: 'user', content: `Extract travel details from this ${documentType} document:\n\n${documentText}` });
    } else {
      return res.status(400).json({ error: 'No document content provided' });
    }

    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openrouterApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-2.5-flash', messages, temperature: 0.1 }),
    });
    if (!aiResponse.ok) throw new Error(`AI gateway error: ${aiResponse.status}`);
    const aiResult = await aiResponse.json();
    const raw = aiResult.choices?.[0]?.message?.content || '{}';
    const cleanedContent = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    const extracted = JSON.parse(cleanedContent);

    const updates: any = {};
    if (extracted.flights?.length) {
      const existingFlights = trip.flights || [];
      const newFlights = extracted.flights.filter((f: any) => !existingFlights.some((e: any) => e.flight_number === f.flight_number && e.departure_datetime === f.departure_datetime));
      if (newFlights.length) updates.flights = [...existingFlights, ...newFlights];
    }
    if (extracted.hotels?.length) {
      const existingHotels = trip.hotels || [];
      const newHotels = extracted.hotels.filter((h: any) => !existingHotels.some((e: any) => e.name === h.name && e.check_in === h.check_in));
      if (newHotels.length) updates.hotels = [...existingHotels, ...newHotels];
    }
    if (extracted.notes && !trip.notes?.includes(extracted.notes)) {
      updates.notes = [trip.notes, extracted.notes].filter(Boolean).join('\n\n');
    }

    const addedCounts = {
      flights: (updates.flights?.length || 0) - (trip.flights?.length || 0),
      hotels: (updates.hotels?.length || 0) - (trip.hotels?.length || 0),
    };

    if (Object.keys(updates).length > 0) {
      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;
      for (const [key, val] of Object.entries(updates)) {
        setClauses.push(`${key} = $${idx}`);
        values.push(typeof val === 'object' ? JSON.stringify(val) : val);
        idx++;
      }
      values.push(tripId);
      await db.query(`UPDATE trips SET ${setClauses.join(', ')} WHERE id = $${idx}`, values);
    }

    const travelers = trip.travelers || [];
    res.json({ success: true, added: addedCounts, calendarEventsCreated: 0, travelers: travelers.filter((t: string) => resolveTravelerEmail(t) !== null) });
  } catch (error: any) {
    console.error('[Travel] trip-document-upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
