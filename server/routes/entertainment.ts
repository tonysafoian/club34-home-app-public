import { Router } from "express";
import { storage } from "../storage";
import { pool } from "../db.js";
import { fetchT } from "../lib/fetchWithTimeout.js";
import { logAudit } from "../lib/auditLog.js";
import * as nodeIcal from 'node-ical';

const router = Router();

function normalizeForDedup(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function dedupeKey(title: string, venue: string, date: string): string {
  const normTitle = normalizeForDedup(title).slice(0, 30);
  const normVenue = normalizeForDedup(venue).slice(0, 15);
  const dateStr = date ? new Date(date).toISOString().split('T')[0] : 'nodate';
  return `${normTitle}|${normVenue}|${dateStr}`;
}

async function fetchSeatGeekEvents(params: Record<string, string>): Promise<any[]> {
  const baseUrl = 'https://api.seatgeek.com/2/events';
  const clientId = process.env.SEATGEEK_CLIENT_ID || process.env.SEATGEEK_API_KEY;
  if (!clientId) return [];
  const url = new URL(baseUrl);
  url.searchParams.set('client_id', clientId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetchT(url.toString(), {}, 10_000);
    if (!res.ok) return [];
    const data = await res.json();
    return data.events || [];
  } catch (e) {
    console.error('SeatGeek API error:', e);
    return [];
  }
}

function parseSeatGeekEvent(evt: any, category: string): any {
  if (!evt.title || !evt.datetime_utc) return null;
  const venue = evt.venue?.name || 'Los Angeles';
  const city = evt.venue?.city || 'Los Angeles';
  const state = evt.venue?.state || 'CA';
  return {
    category,
    title: evt.title,
    venue,
    event_date: new Date(evt.datetime_utc).toISOString(),
    location: `${city}, ${state}`,
    ticket_url: evt.url || null,
    source: 'seatgeek',
    image_url: evt.performers?.[0]?.image || null,
    metadata: { seatgeek_id: evt.id, score: evt.score },
  };
}

function pickBestImage(images: any[]): string | null {
  if (!images || images.length === 0) return null;
  const pool = images.filter(img => img.ratio === '16_9' || img.ratio === '3_2');
  if (pool.length === 0) return images[0].url || null;
  let best = pool[0];
  for (const img of pool) {
    if ((img.width || 0) > (best.width || 0)) best = img;
  }
  return best?.url || null;
}

async function syncConcerts(db: any) {
  const tmKey = process.env.TICKETMASTER_API_KEY;
  const sgKey = process.env.SEATGEEK_CLIENT_ID || process.env.SEATGEEK_API_KEY;
  if (!tmKey) console.warn('[syncConcerts] TICKETMASTER_API_KEY not configured — skipping Ticketmaster source');
  if (!sgKey) console.warn('[syncConcerts] SEATGEEK_CLIENT_ID not configured — skipping SeatGeek source');
  if (!tmKey && !sgKey) return { error: 'Neither TICKETMASTER_API_KEY nor SEATGEEK_CLIENT_ID configured' };

  const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';
  const LA_VENUE_IDS = [
    'KovZpZAJledA', 'KovZpZAFnIEA', 'KovZpZAFaEkA', 'KovZpa2XkE',
    'KovZpZAJ6nlA', 'KovZpZAEkk6A', 'KovZpZAJAIaA', 'KovZpaFEZe',
    'KovZpZAJ6n7A', 'KovZpZAEkdaA',
  ];

  const allConcerts: any[] = [];
  const now = new Date();
  const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
  const endDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z/, 'Z');
  const endDateSg = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (tmKey) {
    async function fetchTmPage(params: Record<string, string>): Promise<any[]> {
      const url = new URL(`${TM_BASE}/events.json`);
      url.searchParams.set('apikey', tmKey!);
      url.searchParams.set('locale', '*');
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      try {
        const res = await fetchT(url.toString(), {}, 15_000);
        if (!res.ok) {
          console.error(`Ticketmaster API error: ${res.status} ${res.statusText}`);
          return [];
        }
        const data = await res.json();
        return data?._embedded?.events || [];
      } catch (e) {
        console.error('Ticketmaster API fetch error:', e);
        return [];
      }
    }

    const venueQueries = LA_VENUE_IDS.map(venueId => ({
      venueId, classificationName: 'music',
      startDateTime: startDate, endDateTime: endDate,
      size: '100', sort: 'date,asc',
    }));
    const geoQuery = {
      classificationName: 'music', latlong: '34.0522,-118.2437',
      radius: '30', unit: 'miles',
      startDateTime: startDate, endDateTime: endDate,
      size: '200', sort: 'date,asc',
    };

    const allQueries = [...venueQueries, geoQuery];
    for (const q of allQueries) {
      const events = await fetchTmPage(q);
      for (const evt of events) {
        const title = evt.name;
        if (!title) continue;
        let eventDate: string;
        const dates = evt.dates?.start;
        if (dates?.dateTime) {
          eventDate = new Date(dates.dateTime).toISOString();
        } else if (dates?.localDate) {
          eventDate = new Date(dates.localDate + 'T20:00:00').toISOString();
        } else continue;
        if (new Date(eventDate) < now) continue;
        const venueObj = evt._embedded?.venues?.[0];
        const venue = venueObj?.name || 'Los Angeles';
        const city = venueObj?.city?.name || 'Los Angeles';
        const state = venueObj?.state?.stateCode || 'CA';
        allConcerts.push({
          category: 'concert', title, venue, event_date: eventDate,
          location: `${city}, ${state}`,
          ticket_url: evt.url || null, source: 'ticketmaster',
          image_url: pickBestImage(evt.images || []),
        });
      }
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[syncConcerts] Ticketmaster: ${allConcerts.length} raw events`);
  }

  if (sgKey) {
    const sgQueries = [
      { 'taxonomies.name': 'concert', lat: '34.0522', lon: '-118.2437', range: '30mi', per_page: '200', 'datetime_utc.gte': now.toISOString().slice(0, 10), 'datetime_utc.lte': endDateSg, sort: 'datetime_utc.asc' },
      { 'taxonomies.name': 'concert', lat: '34.0522', lon: '-118.2437', range: '30mi', per_page: '200', 'datetime_utc.gte': now.toISOString().slice(0, 10), 'datetime_utc.lte': endDateSg, sort: 'score.desc' },
    ];
    const beforeSg = allConcerts.length;
    for (const q of sgQueries) {
      const events = await fetchSeatGeekEvents(q);
      for (const evt of events) {
        const parsed = parseSeatGeekEvent(evt, 'concert');
        if (parsed) allConcerts.push(parsed);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[syncConcerts] SeatGeek: ${allConcerts.length - beforeSg} raw events`);
  }

  if (allConcerts.length === 0) return { synced: 0, note: 'No concerts found' };
  const seen = new Set<string>();
  const uniqueConcerts = allConcerts.filter(c => {
    const key = dedupeKey(c.title, c.venue, c.event_date);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[syncConcerts] ${allConcerts.length} raw → ${uniqueConcerts.length} unique concerts — replacing DB records`);

  // Transactional safe-swap: only delete+insert if we have results
  const client = await pool.connect();
  let synced = 0;
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM entertainment_events WHERE category = 'concert' AND event_date >= $1`, [now.toISOString()]);
    for (const c of uniqueConcerts) {
      await client.query(
        `INSERT INTO entertainment_events (category, title, venue, event_date, location, ticket_url, source, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [c.category, c.title, c.venue, c.event_date, c.location, c.ticket_url, c.source, c.image_url]
      );
      synced++;
    }
    await client.query('COMMIT');
  } catch (txErr: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[syncConcerts] Transaction failed, rolled back:', txErr.message);
    throw txErr;
  } finally {
    client.release();
  }
  console.log(`[syncConcerts] Total: ${allConcerts.length} raw → ${uniqueConcerts.length} unique → ${synced} inserted`);
  return { synced, sources: { ticketmaster: allConcerts.filter(c => c.source === 'ticketmaster').length, seatgeek: allConcerts.filter(c => c.source === 'seatgeek').length } };
}

async function syncShows(db: any) {
  const tmKey = process.env.TICKETMASTER_API_KEY;
  const sgKey = process.env.SEATGEEK_CLIENT_ID || process.env.SEATGEEK_API_KEY;
  if (!tmKey) console.warn('[syncShows] TICKETMASTER_API_KEY not configured — skipping Ticketmaster source');
  if (!sgKey) console.warn('[syncShows] SEATGEEK_CLIENT_ID not configured — skipping SeatGeek source');
  if (!tmKey && !sgKey) return { error: 'Neither TICKETMASTER_API_KEY nor SEATGEEK_CLIENT_ID configured' };

  const allShows: any[] = [];
  const now = new Date();
  const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
  const endDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z/, 'Z');
  const endDateSg = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlKey) console.warn('[syncShows] FIRECRAWL_API_KEY not configured — skipping venue scraping source');
  const nowYear = now.getFullYear();
  const yearRangePattern = `(${nowYear}|${nowYear + 1}|${nowYear + 2})`;
  const dateMonthYearRx = new RegExp(`(\\w{3,9}\\s+\\d{1,2},?\\s+${yearRangePattern})`, 'i');
  const dateMdYRx = new RegExp(`(\\d{1,2}\\/\\d{1,2}\\/${yearRangePattern})`);
  const dateIsoRx = new RegExp(`(${yearRangePattern}-\\d{2}-\\d{2})`);

  const SHOW_GENERIC_TERMS = [
    'home', 'about', 'contact', 'menu', 'navigation', 'subscribe', 'newsletter',
    'login', 'sign in', 'sign up', 'search', 'calendar', 'events', 'tickets',
    'buy tickets', 'book now', 'learn more', 'read more', 'view all', 'see all',
    'follow us', 'share', 'donate', 'support', 'membership', 'gift cards',
    'parking', 'accessibility', 'directions', 'faq', 'press', 'careers',
    'privacy policy', 'terms', 'copyright', 'all rights reserved',
    'box office', 'group sales', 'education', 'community', 'season',
  ];

  const SHOW_VENUE_NAMES = [
    'ahmanson theatre', 'hollywood pantages', 'geffen playhouse',
    'a noise within', 'dolby theatre', 'segerstrom center', 'la mirada theatre',
    'comedy store', 'laugh factory', 'center theatre group',
  ];

  function isGenericShowLine(line: string): boolean {
    const lower = line.toLowerCase().trim();
    if (lower.length < 3 || lower.length > 120) return true;
    for (const term of SHOW_GENERIC_TERMS) {
      if (lower === term) return true;
    }
    for (const vn of SHOW_VENUE_NAMES) {
      if (lower === vn || lower.startsWith(vn + ' -') || lower.startsWith(vn + ' |')) return true;
    }
    if (/^(https?:\/\/|\$|\d+(\.\d+)?$)/.test(lower)) return true;
    if (/^(tickets?|buy|sold out|price|on sale|now playing|coming soon|presented by|sponsored by|brought to you)/i.test(lower)) return true;
    if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower) && lower.length < 20) return true;
    if (/^\d{1,2}:\d{2}/.test(lower)) return true;
    if (/^(pm|am)\b/i.test(lower)) return true;
    if (/^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(lower)) return true;
    return false;
  }

  function looksLikeShowTitle(text: string): boolean {
    const words = text.trim().split(/\s+/);
    if (words.length < 1 || words.length > 9) return false;
    if (text.trim().endsWith('.') || text.trim().endsWith('?')) return false;
    const titleCaseWords = words.filter(w => /^[A-Z]/.test(w) || /^(a|an|the|of|in|on|at|to|and|or|by|for|with|de|la|el|le)$/i.test(w));
    const titleCaseRatio = titleCaseWords.length / words.length;
    return titleCaseRatio >= 0.5;
  }

  function cleanShowTitle(raw: string): string {
    return raw
      .replace(/[#*\[\]_]/g, '')
      .split(' | ')[0]
      .split(' - Tickets')[0]
      .split(' Tickets')[0]
      .replace(/\s*[-–]\s*(Ticketmaster|Live Nation|AXS|StubHub|Vivid Seats|SeatGeek).*$/i, '')
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();
  }

  function extractDateFromContent(text: string): string | null {
    const thisYear = now.getFullYear();
    const datePatterns = [
      dateMonthYearRx,
      dateMdYRx,
      dateIsoRx,
      new RegExp(`(?:through|thru|until|–|-)\\s*(\\w{3,9}\\s+\\d{1,2},?\\s*${yearRangePattern})`, 'i'),
      new RegExp(`(?:opens?|runs?|starts?|begins?)\\s+(\\w{3,9}\\s+\\d{1,2},?\\s*${yearRangePattern})`, 'i'),
    ];
    for (const pat of datePatterns) {
      const m = text.match(pat);
      if (m) {
        try {
          const d = new Date(m[1] || m[0]);
          if (!isNaN(d.getTime()) && d > now) return d.toISOString();
        } catch {}
      }
    }
    const monthDayRx = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})\b/i;
    const md = text.match(monthDayRx);
    if (md) {
      try {
        let d = new Date(`${md[1]} ${md[2]}, ${thisYear}`);
        if (isNaN(d.getTime()) || d <= now) d = new Date(`${md[1]} ${md[2]}, ${thisYear + 1}`);
        if (!isNaN(d.getTime()) && d > now) return d.toISOString();
      } catch {}
    }
    return null;
  }

  function extractTicketLinkFromBlock(lines: string[], startIdx: number, count: number): string | null {
    const block = lines.slice(startIdx, startIdx + count).join('\n');
    const linkRx = /\[(?:tickets?|buy|get tickets?|book|purchase)[^\]]*\]\((https?:\/\/[^)]+)\)/i;
    const m = block.match(linkRx);
    if (m) return m[1];
    const urlRx = /https?:\/\/((?:www\.)?(ticketmaster|axs|telecharge|ovationtix|goldstar|eventbrite|theatermania)\.[^\s)]+)/i;
    const um = block.match(urlRx);
    if (um) return `https://${um[1]}`;
    return null;
  }

  if (firecrawlKey) {
    const venueUrls = [
      { url: 'https://www.centertheatregroup.org/tickets/ahmanson-theatre/', venue: 'Ahmanson Theatre' },
      { url: 'https://www.centertheatregroup.org/tickets/mark-taper-forum/', venue: 'Mark Taper Forum' },
      { url: 'https://www.hollywoodpantages.com/', venue: 'Hollywood Pantages Theatre' },
      { url: 'https://www.geffenplayhouse.org/shows/', venue: 'Geffen Playhouse' },
      { url: 'https://www.anoisewithin.org/shows/', venue: 'A Noise Within' },
      { url: 'https://www.lamiradatheatre.com/', venue: 'La Mirada Theatre' },
      { url: 'https://www.segerstromcenter.org/visit/calendar', venue: 'Segerstrom Center for the Arts' },
      { url: 'https://www.dolbytheatre.com/', venue: 'Dolby Theatre' },
      { url: 'https://www.thecomedystore.com/calendar/', venue: 'The Comedy Store' },
      { url: 'https://www.laughfactory.com/clubs/los-angeles/shows', venue: 'Laugh Factory' },
    ];

    await Promise.all(venueUrls.map(async ({ url, venue }) => {
      try {
        const res = await fetchT('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, waitFor: 2000 }),
        });
        const scraped = await res.json();
        const markdown: string = scraped?.data?.markdown || scraped?.markdown || '';
        if (!markdown) return;

        const lines = markdown.split('\n');
        let currentDate = '';
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          const trimmed = line.trim();

          const dateHeadingRx = new RegExp(`^#+\\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*${yearRangePattern})`, 'i');
          const dateBareRx = new RegExp(`^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*${yearRangePattern})$`, 'i');
          const dateLine = trimmed.match(dateHeadingRx) || trimmed.match(dateBareRx);
          if (dateLine) {
            currentDate = dateLine[1];
            i++;
            continue;
          }

          const isHeading = /^#{1,3}\s+/.test(trimmed);
          const rawTitle = trimmed.replace(/^#+\s*/, '').replace(/[*\[\]_]/g, '').trim();

          if (!isHeading && !isGenericShowLine(rawTitle) && rawTitle.length >= 4 && looksLikeShowTitle(rawTitle)) {
            const contextLines = lines.slice(i + 1, i + 6);
            const contextBlock = `${trimmed} ${contextLines.join(' ')}`;
            let extractedDate = currentDate ? extractDateFromContent(currentDate) : null;
            if (!extractedDate) extractedDate = extractDateFromContent(contextBlock);
            const eventDate = extractedDate || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
            const title = cleanShowTitle(rawTitle);
            if (title.length >= 3 && !isGenericShowLine(title)) {
              const perEventLink = extractTicketLinkFromBlock(lines, i, 6);
              allShows.push({
                category: 'shows', title, venue, event_date: eventDate, event_end: null,
                location: 'Los Angeles, CA', ticket_url: perEventLink || url, source: 'scraped',
              });
            }
          } else if (isHeading) {
            const rawHeadingTitle = trimmed.replace(/^#+\s*/, '').replace(/[*\[\]_]/g, '').trim();
            if (!isGenericShowLine(rawHeadingTitle) && rawHeadingTitle.length >= 4) {
              const contextLines = lines.slice(i + 1, i + 7);
              const contextBlock = `${rawHeadingTitle} ${contextLines.join(' ')}`;
              let extractedDate = currentDate ? extractDateFromContent(currentDate) : null;
              if (!extractedDate) extractedDate = extractDateFromContent(contextBlock);
              const eventDate = extractedDate || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
              const title = cleanShowTitle(rawHeadingTitle);
              if (title.length >= 3 && !isGenericShowLine(title)) {
                const perEventLink = extractTicketLinkFromBlock(lines, i + 1, 7);
                allShows.push({
                  category: 'shows', title, venue, event_date: eventDate, event_end: null,
                  location: 'Los Angeles, CA', ticket_url: perEventLink || url, source: 'scraped',
                });
              }
            }
          }
          i++;
        }
      } catch (e) { console.error(`Venue scrape error for ${venue}:`, e); }
    }));

    const venueMappings: [string, string][] = [
      ['ahmanson', 'Ahmanson Theatre'], ['pantages', 'Hollywood Pantages Theatre'],
      ['geffen', 'Geffen Playhouse'], ['a noise within', 'A Noise Within'],
      ['la mirada', 'La Mirada Theatre'], ['segerstrom', 'Segerstrom Center for the Arts'],
      ['dolby theatre', 'Dolby Theatre'], ['comedy store', 'The Comedy Store'],
      ['laugh factory', 'Laugh Factory'], ['mark taper', 'Mark Taper Forum'],
      ['hollywood bowl', 'Hollywood Bowl'], ['royce hall', 'Royce Hall UCLA'],
      ['broadstage', 'Broad Stage'], ['kirk douglas', 'Kirk Douglas Theatre'],
    ];

    function isGenericShowTitle(title: string): boolean {
      const lower = title.toLowerCase().trim();
      for (const term of SHOW_GENERIC_TERMS) {
        if (lower === term || lower.startsWith(term + ' ')) return true;
      }
      if (/^(all )?(tickets?|shows?|events?|broadway|theater|theatre)( in| near| at| for| los angeles)?/i.test(lower)) return true;
      return lower.length < 3;
    }

    const searchQueries = [
      `site:ticketmaster.com broadway musical Los Angeles ${nowYear} tickets`,
      `site:ticketmaster.com "Ahmanson Theatre" OR "Hollywood Pantages" show ${nowYear}`,
      `site:ticketmaster.com "Dolby Theatre" OR "Segerstrom" theater show ${nowYear}`,
      `Broadway touring show Los Angeles ${nowYear} Pantages Ahmanson tickets`,
      `site:ticketmaster.com "Disney on Ice" OR "Cirque du Soleil" Los Angeles ${nowYear}`,
      `"coming to Los Angeles" ${nowYear} broadway musical touring show tickets`,
      `Los Angeles theater show comedy ${nowYear} tickets family entertainment live`,
    ];

    await Promise.all(searchQueries.map(async (query) => {
      try {
        const searchRes = await fetchT('https://api.firecrawl.dev/v1/search', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${firecrawlKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, limit: 10, lang: 'en', country: 'us', scrapeOptions: { formats: ['markdown'] } }),
        });
        const searchData = await searchRes.json();
        const results = searchData?.data || [];
        for (const result of results) {
          const rawTitle = result.title || '';
          const desc = result.description || '';
          const markdown = result.markdown || '';
          const combined = `${rawTitle} ${desc} ${markdown}`;
          if (!rawTitle) continue;

          const url = (result.url || '').toLowerCase();
          if (url.includes('ticketmaster.com')) {
            const isListingPage = /ticketmaster\.com\/(discover|search|browse|category|venue)/i.test(url);
            const isEventPage = /ticketmaster\.com\/event\//i.test(url);
            if (isListingPage && !isEventPage) continue;
          }

          let title = rawTitle
            .split(' | ')[0]
            .split(' Tickets')[0]
            .replace(/\s*[-–]\s*(Ticketmaster|Live Nation|AXS|StubHub|Vivid Seats|SeatGeek).*$/i, '')
            .trim();

          if (isGenericShowTitle(title)) continue;

          const extractedDate = extractDateFromContent(combined);
          const eventDate = extractedDate || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

          let venue = 'Los Angeles';
          const lowerCombined = combined.toLowerCase();
          for (const [key, name] of venueMappings) {
            if (lowerCombined.includes(key)) { venue = name; break; }
          }

          allShows.push({
            category: 'shows', title,
            venue, event_date: eventDate, location: 'Los Angeles, CA',
            ticket_url: result.url || null, source: 'search',
          });
        }
      } catch (e) { console.error(`Show search error for "${query}":`, e); }
    }));
  }

  if (tmKey) {
    const TM_BASE = 'https://app.ticketmaster.com/discovery/v2';
    const segmentIds = ['KZFzniwnSyZfZ7v7na', 'KZFzniwnSyZfZ7v7n1'];
    const beforeTm = allShows.length;
    for (const segmentId of segmentIds) {
      try {
        const url = new URL(`${TM_BASE}/events.json`);
        url.searchParams.set('apikey', tmKey);
        url.searchParams.set('segmentId', segmentId);
        url.searchParams.set('dmaId', '324');
        url.searchParams.set('size', '100');
        url.searchParams.set('sort', 'date,asc');
        url.searchParams.set('startDateTime', startDate);
        url.searchParams.set('endDateTime', endDate);

        const res = await fetchT(url.toString(), {}, 15_000);
        if (res.ok) {
          const data = await res.json();
          const events = data?._embedded?.events || [];
          for (const evt of events) {
            const title = evt.name;
            if (!title) continue;
            let eventDate: string;
            const dates = evt.dates?.start;
            if (dates?.dateTime) eventDate = new Date(dates.dateTime).toISOString();
            else if (dates?.localDate) eventDate = new Date(dates.localDate + 'T20:00:00').toISOString();
            else continue;
            if (new Date(eventDate) < now) continue;
            const venueObj = evt._embedded?.venues?.[0];
            allShows.push({
              category: 'shows', title, venue: venueObj?.name || 'Los Angeles',
              event_date: eventDate, event_end: null,
              location: `${venueObj?.city?.name || 'Los Angeles'}, ${venueObj?.state?.stateCode || 'CA'}`,
              ticket_url: evt.url || null, source: 'ticketmaster',
              image_url: pickBestImage(evt.images || []),
            });
          }
        }
      } catch (e) { console.error(`TM shows segment ${segmentId} error:`, e); }
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[syncShows] Ticketmaster: ${allShows.length - beforeTm} shows from API`);
  }

  if (sgKey) {
    const sgShowTypes = ['theater', 'broadway_tickets_national', 'comedy', 'family'];
    const beforeSg = allShows.length;
    for (const taxo of sgShowTypes) {
      const events = await fetchSeatGeekEvents({
        'taxonomies.name': taxo, lat: '34.0522', lon: '-118.2437', range: '30mi',
        per_page: '100', 'datetime_utc.gte': now.toISOString().slice(0, 10),
        'datetime_utc.lte': endDateSg, sort: 'datetime_utc.asc',
      });
      for (const evt of events) {
        const parsed = parseSeatGeekEvent(evt, 'shows');
        if (parsed) allShows.push(parsed);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    console.log(`[syncShows] SeatGeek: ${allShows.length - beforeSg} shows from API`);
  }

  if (allShows.length === 0) return { synced: 0, note: 'No shows found' };
  const seen = new Set<string>();
  const unique = allShows.filter(s => {
    const key = dedupeKey(s.title, s.venue, s.event_date);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`[syncShows] ${allShows.length} raw → ${unique.length} unique shows — replacing DB records`);

  // Transactional safe-swap: only delete+insert if we have results
  const client = await pool.connect();
  let synced = 0;
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM entertainment_events WHERE category IN ('show', 'shows') AND event_date >= $1`, [now.toISOString()]);
    for (const s of unique) {
      await client.query(
        `INSERT INTO entertainment_events (category, title, venue, event_date, event_end, location, ticket_url, metadata, source, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [s.category, s.title, s.venue, s.event_date, s.event_end, s.location, s.ticket_url, JSON.stringify(s.metadata || {}), s.source, s.image_url || null]
      );
      synced++;
    }
    await client.query('COMMIT');
  } catch (txErr: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[syncShows] Transaction failed, rolled back:', txErr.message);
    throw txErr;
  } finally {
    client.release();
  }
  console.log(`[syncShows] Total: ${allShows.length} raw → ${unique.length} unique → ${synced} inserted`);
  return { synced, sources: { ticketmaster: allShows.filter(s => s.source === 'ticketmaster').length, seatgeek: allShows.filter(s => s.source === 'seatgeek').length } };
}

async function syncLakers(db: any) {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const allGames: any[] = [];

    // Helper: derive season string like "2025-26" from a year
    function nbaSeasonString(year: number): string {
      return `${year}-${String(year + 1).slice(2)}`;
    }

    // Primary source: NBA Lakers iCal feed
    // NBA seasons start in October. Before July, the current season likely started
    // the prior year (e.g., in March 2026 the season is 2025-26).
    // After July, the new season may be starting soon (try currentYear first).
    const nowMonth = now.getMonth(); // 0-indexed; July = 6
    const primarySeasonYear = nowMonth >= 6 ? currentYear : currentYear - 1;
    const lakers_ical_seasons = [
      nbaSeasonString(primarySeasonYear),
      nbaSeasonString(primarySeasonYear + 1),
    ];
    const lakersIcalUrls = lakers_ical_seasons.map(
      s => `https://statics.nba.com/static/content/static/schedule/${s}/ical/LAL.ics`
    );
    let icalSuccess = false;
    for (const icalUrl of lakersIcalUrls) {
      try {
        console.log(`[syncLakers] Fetching Lakers iCal feed from ${icalUrl}...`);
        const icalRes = await fetchT(icalUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarSync/1.0)', 'Accept': 'text/calendar, */*' } }, 15_000);
        if (!icalRes.ok) {
          console.warn(`[syncLakers] iCal fetch failed: HTTP ${icalRes.status} ${icalRes.statusText}`);
          continue;
        }
        const icalText = await icalRes.text();
        const parsed = nodeIcal.sync.parseICS(icalText);
        let gameCount = 0;
        for (const key of Object.keys(parsed)) {
          const event = parsed[key];
          if (!event || event.type !== 'VEVENT') continue;
          const summary = (event.summary as string) || '';
          const startDate = event.start as Date;
          if (!startDate || !(startDate instanceof Date) || isNaN(startDate.getTime())) continue;
          if (startDate <= now) continue;
          // Parse Lakers game from iCal SUMMARY
          // Common formats:
          //   "Los Angeles Lakers vs. Opponent" (home, Lakers first)
          //   "Los Angeles Lakers at Opponent"  (away, Lakers traveling)
          //   "Opponent vs. Los Angeles Lakers" (home, opponent first — treat as home)
          //   "Opponent at Los Angeles Lakers"  (home, opponent traveling to Staples)
          const summaryLower = summary.toLowerCase();
          let isHome = true;
          let opponent = '';
          let title = summary;
          if (summaryLower.includes(' vs.') || summaryLower.includes(' vs ')) {
            const lakersFirstMatch = summary.match(/(?:Los Angeles Lakers|Lakers)\s+vs\.?\s+(.+)/i);
            if (lakersFirstMatch) {
              isHome = true;
              opponent = lakersFirstMatch[1].trim();
            } else {
              // Opponent-first: "X vs. Los Angeles Lakers"
              const oppFirstMatch = summary.match(/(.+)\s+vs\.?\s+(?:Los Angeles Lakers|Lakers)/i);
              if (oppFirstMatch) {
                isHome = true;
                opponent = oppFirstMatch[1].trim();
              } else {
                opponent = summary;
              }
            }
            title = `Lakers vs. ${opponent}`;
          } else if (summaryLower.includes(' at ')) {
            const lakersAwayMatch = summary.match(/(?:Los Angeles Lakers|Lakers)\s+at\s+(.+)/i);
            if (lakersAwayMatch) {
              isHome = false;
              opponent = lakersAwayMatch[1].trim();
              title = `Lakers at ${opponent}`;
            } else {
              // "Opponent at Los Angeles Lakers" → home game
              const oppAwayMatch = summary.match(/(.+)\s+at\s+(?:Los Angeles Lakers|Lakers)/i);
              if (oppAwayMatch) {
                isHome = true;
                opponent = oppAwayMatch[1].trim();
                title = `Lakers vs. ${opponent}`;
              } else {
                title = summary;
              }
            }
          }
          // Derive a simple tricode from opponent name (last word, uppercase, first 3 chars)
          const opponentTricode = opponent ? opponent.split(' ').pop()?.slice(0, 3).toUpperCase() || '' : '';
          const locationStr = (event.location as string) || '';
          const venue = isHome ? 'Crypto.com Arena' : (locationStr || 'Away Arena');
          const locationCity = isHome ? 'Los Angeles, CA' : (locationStr || 'Away');
          allGames.push({
            category: 'lakers', title, venue,
            event_date: startDate.toISOString(),
            location: locationCity,
            ticket_url: null, source: 'ical', image_url: null,
            metadata: {
              homeAway: isHome ? 'home' : 'away',
              opponent,
              opponentTricode,
              broadcastChannels: ['Spectrum SportsNet'],
            },
          });
          gameCount++;
        }
        console.log(`[syncLakers] iCal: ${gameCount} Lakers games parsed from ${icalUrl}`);
        if (gameCount > 0) {
          icalSuccess = true;
          break;
        }
      } catch (icalErr: any) {
        console.warn(`[syncLakers] iCal fetch/parse error for ${icalUrl}:`, icalErr.message);
      }
    }

    // Fallback source: NBA schedule JSON (free, no API key required)
    if (!icalSuccess) {
      try {
        console.log('[syncLakers] iCal failed — falling back to NBA schedule JSON from cdn.nba.com...');
        const nbaRes = await fetchT('https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 15_000);
        if (!nbaRes.ok) {
          console.warn(`[syncLakers] NBA schedule fetch failed: HTTP ${nbaRes.status} ${nbaRes.statusText}`);
        } else {
          const nbaData = await nbaRes.json();
          const gameDates: any[] = nbaData?.leagueSchedule?.gameDates || [];
          let rawCount = 0;
          for (const dateEntry of gameDates) {
            for (const game of (dateEntry.games || [])) {
              rawCount++;
              const homeCity = game.homeTeam?.teamCity || '';
              const awayCity = game.awayTeam?.teamCity || '';
              const isLakersHome = homeCity === 'Los Angeles' && game.homeTeam?.teamName === 'Lakers';
              const isLakersAway = awayCity === 'Los Angeles' && game.awayTeam?.teamName === 'Lakers';
              if (!isLakersHome && !isLakersAway) continue;
              const gameDateTimeUtc = game.gameDateTimeUTC || game.gameDateTimeEst || game.gameDateTime;
              if (!gameDateTimeUtc) continue;
              const eventDate = new Date(gameDateTimeUtc);
              if (isNaN(eventDate.getTime()) || eventDate <= now) continue;
              const isHome = isLakersHome;
              const opponentFull = isHome
                ? `${game.awayTeam?.teamCity || ''} ${game.awayTeam?.teamName || ''}`.trim()
                : `${game.homeTeam?.teamCity || ''} ${game.homeTeam?.teamName || ''}`.trim();
              const opponentTricode = isHome ? (game.awayTeam?.teamTricode || '') : (game.homeTeam?.teamTricode || '');
              const title = isHome ? `Lakers vs. ${opponentFull}` : `Lakers at ${opponentFull}`;
              const venue = isHome ? 'Crypto.com Arena' : (game.arenaName || `${game.homeTeam?.teamCity || ''} Arena`);
              const location = isHome ? 'Los Angeles, CA' : `${game.arenaCity || game.homeTeam?.teamCity || ''}, ${game.arenaState || 'USA'}`;
              const nationalBroadcasters = (game.broadcasters?.nationalBroadcasters || []).map((b: any) => b.broadcasterDisplay || '');
              const localBroadcasters = (game.broadcasters?.homeTvBroadcasters || []).map((b: any) => b.broadcasterDisplay || '');
              const broadcastChannels: string[] = [...new Set([...nationalBroadcasters, ...localBroadcasters, 'Spectrum SportsNet'])].filter(Boolean);
              allGames.push({
                category: 'lakers', title, venue, event_date: eventDate.toISOString(),
                location, ticket_url: null, source: 'nba', image_url: null,
                metadata: {
                  homeAway: isHome ? 'home' : 'away',
                  opponent: opponentFull,
                  opponentTricode,
                  gameId: game.gameId,
                  broadcastChannels,
                },
              });
            }
          }
          console.log(`[syncLakers] NBA schedule: ${rawCount} total games, ${allGames.length} Lakers games found`);
        }
      } catch (nbaErr: any) {
        console.warn('[syncLakers] NBA schedule fetch error:', nbaErr.message);
      }
    }

    // Supplement/fallback: Ticketmaster
    const tmKey = process.env.TICKETMASTER_API_KEY;
    if (tmKey && allGames.length === 0) {
      console.log('[syncLakers] Falling back to Ticketmaster...');
      const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
      const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${tmKey}&keyword=Lakers&classificationName=NBA&latlong=34.0430,-118.2673&radius=5&unit=miles&size=50&sort=date,asc&startDateTime=${startDate}`;
      try {
        const tmRes = await fetchT(tmUrl, {}, 15_000);
        if (!tmRes.ok) {
          const errBody = await tmRes.text().catch(() => '');
          console.warn(`[syncLakers] Ticketmaster fetch failed: HTTP ${tmRes.status} ${tmRes.statusText} — ${errBody.slice(0, 200)}`);
        } else {
          const tmData = await tmRes.json();
          const tmEvents = tmData?._embedded?.events || [];
          console.log(`[syncLakers] Ticketmaster: ${tmEvents.length} raw events`);
          for (const evt of tmEvents) {
            if (!evt.name) continue;
            const dateStr = evt.dates?.start?.dateTime || evt.dates?.start?.localDate;
            if (!dateStr) continue;
            const eventDate = new Date(dateStr);
            if (eventDate <= now) continue;
            allGames.push({
              category: 'lakers', title: evt.name,
              venue: evt._embedded?.venues?.[0]?.name || 'Crypto.com Arena',
              event_date: eventDate.toISOString(),
              location: 'Los Angeles, CA',
              ticket_url: evt.url || null, source: 'ticketmaster',
              image_url: pickBestImage(evt.images || []),
              metadata: { homeAway: 'home', opponent: '', opponentTricode: '', broadcastChannels: ['Spectrum SportsNet'] },
            });
          }
        }
      } catch (tmErr: any) {
        console.warn('[syncLakers] Ticketmaster error:', tmErr.message);
      }
    } else if (tmKey && allGames.length > 0) {
      // Enrich with Ticketmaster ticket URLs
      const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
      const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${tmKey}&keyword=Lakers&classificationName=NBA&latlong=34.0430,-118.2673&radius=5&unit=miles&size=50&sort=date,asc&startDateTime=${startDate}`;
      try {
        const tmRes = await fetchT(tmUrl, {}, 15_000);
        if (tmRes.ok) {
          const tmData = await tmRes.json();
          const tmEvents = tmData?._embedded?.events || [];
          const tmMap = new Map<string, string>();
          for (const evt of tmEvents) {
            const dateStr = evt.dates?.start?.dateTime || evt.dates?.start?.localDate;
            if (dateStr && evt.url) {
              const key = new Date(dateStr).toISOString().split('T')[0];
              tmMap.set(key, evt.url);
            }
          }
          for (const game of allGames) {
            const key = game.event_date.split('T')[0];
            if (tmMap.has(key)) game.ticket_url = tmMap.get(key)!;
          }
          console.log(`[syncLakers] Enriched ${tmMap.size} games with Ticketmaster ticket URLs`);
        }
      } catch { /* non-fatal */ }
    }

    if (allGames.length === 0) {
      console.warn('[syncLakers] No games found from any source — preserving existing data');
      return { synced: 0, note: 'No games found from iCal, NBA, or Ticketmaster — existing data preserved' };
    }

    // Deduplicate by date
    const seen = new Set<string>();
    const unique = allGames.filter(g => {
      const key = g.event_date.split('T')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[syncLakers] ${allGames.length} raw → ${unique.length} unique games — replacing DB records`);

    // Transactional safe-swap
    const client = await pool.connect();
    let synced = 0;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM entertainment_events WHERE category = 'lakers' AND event_date >= $1`, [now.toISOString()]);
      for (const game of unique) {
        await client.query(
          `INSERT INTO entertainment_events (category, title, venue, event_date, location, ticket_url, metadata, source, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [game.category, game.title, game.venue, game.event_date, game.location, game.ticket_url, JSON.stringify(game.metadata || {}), game.source, game.image_url || null]
        );
        synced++;
      }
      await client.query('COMMIT');
    } catch (txErr: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[syncLakers] Transaction failed, rolled back:', txErr.message);
      throw txErr;
    } finally {
      client.release();
    }
    console.log(`[syncLakers] Inserted ${synced} games`);
    return { synced, sources: { ical: allGames.filter(g => g.source === 'ical').length, nba: allGames.filter(g => g.source === 'nba').length, ticketmaster: allGames.filter(g => g.source === 'ticketmaster').length } };
  } catch (e: any) {
    console.error('[syncLakers] Unexpected error:', e.message);
    return { error: e.message };
  }
}

const F1_FLAGS: Record<string, string> = {
  Australia: '🇦🇺', Bahrain: '🇧🇭', 'Saudi Arabia': '🇸🇦', China: '🇨🇳',
  Japan: '🇯🇵', USA: '🇺🇸', 'United States': '🇺🇸', Italy: '🇮🇹',
  Monaco: '🇲🇨', Canada: '🇨🇦', Spain: '🇪🇸', Austria: '🇦🇹',
  UK: '🇬🇧', 'United Kingdom': '🇬🇧', Hungary: '🇭🇺', Belgium: '🇧🇪',
  Netherlands: '🇳🇱', Singapore: '🇸🇬', Azerbaijan: '🇦🇿', Mexico: '🇲🇽',
  Brazil: '🇧🇷', 'Las Vegas': '🇺🇸', Qatar: '🇶🇦', 'Abu Dhabi': '🇦🇪',
  UAE: '🇦🇪',
};

function f1SessionLabel(summary: string): string {
  const s = summary.toLowerCase();
  if (s.includes('sprint qualifying') || s.includes('sprint shootout')) return 'Sprint Qualifying';
  if (s.includes('sprint race') || (s.includes('sprint') && !s.includes('qualifying') && !s.includes('shootout') && !s.includes('practice'))) return 'Sprint Race';
  if (s.includes('practice 1') || s.includes('fp1')) return 'Practice 1';
  if (s.includes('practice 2') || s.includes('fp2')) return 'Practice 2';
  if (s.includes('practice 3') || s.includes('fp3')) return 'Practice 3';
  if (s.includes('qualifying')) return 'Qualifying';
  if (s.includes('grand prix') || s.includes(' race') || / gp\b/.test(s)) return 'Race';
  return '';
}

function f1RaceName(summary: string): string {
  return summary
    .replace(/\s*[-–|:]\s*(practice \d+|fp\d|sprint qualifying|sprint shootout|sprint race|sprint|qualifying|grand prix| race| gp)\s*$/i, '')
    .trim() || summary;
}

async function syncF1(db: any) {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    // allRaces: one entry per race weekend with metadata.sessions
    const allRaces: any[] = [];

    // Primary source: F1 iCal feed — group sessions by race weekend
    const f1IcalUrls = [
      'https://f1calendar.com/download/f1-calendar_q_sprint_gp.ics',
      'https://files-f1.motorsportcalendars.com/f1-calendar_p_q_sprint_gp.ics',
    ];
    let f1IcalSuccess = false;
    for (const icalUrl of f1IcalUrls) {
      try {
        console.log(`[syncF1] Fetching F1 iCal feed from ${icalUrl}...`);
        const icalRes = await fetchT(icalUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CalendarSync/1.0)', 'Accept': 'text/calendar, */*' } }, 20_000);
        if (!icalRes.ok) {
          console.warn(`[syncF1] iCal fetch failed: HTTP ${icalRes.status} ${icalRes.statusText}`);
          continue;
        }
        const icalText = await icalRes.text();
        const parsed = nodeIcal.sync.parseICS(icalText);

        // Group sessions by race name (normalized) into weekend buckets
        const weekendMap = new Map<string, { raceName: string; circuit: string; country: string; sessions: Array<{ name: string; date: string; time: string; startMs: number }>; }>();

        for (const key of Object.keys(parsed)) {
          const event = parsed[key];
          if (!event || event.type !== 'VEVENT') continue;
          const summary = (event.summary as string) || '';
          const startDate = event.start as Date;
          if (!startDate || !(startDate instanceof Date) || isNaN(startDate.getTime())) continue;

          const sessionName = f1SessionLabel(summary);
          const raceName = f1RaceName(summary);
          if (!raceName) continue;

          const locationStr = (event.location as string) || '';
          // Normalize race name to group sessions from the same GP
          const normalizedRace = raceName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);

          if (!weekendMap.has(normalizedRace)) {
            weekendMap.set(normalizedRace, { raceName, circuit: locationStr || 'F1 Circuit', country: '', sessions: [] });
          }
          const bucket = weekendMap.get(normalizedRace)!;
          if (locationStr && !bucket.circuit) bucket.circuit = locationStr;

          if (sessionName) {
            bucket.sessions.push({
              name: sessionName,
              date: startDate.toISOString().split('T')[0],
              time: startDate.toISOString().split('T')[1].replace('Z', '+00:00'),
              startMs: startDate.getTime(),
            });
          }
        }

        for (const [, bucket] of weekendMap) {
          if (bucket.sessions.length === 0) continue;
          // Sort sessions chronologically
          bucket.sessions.sort((a, b) => a.startMs - b.startMs);
          const firstSession = bucket.sessions[0];
          const lastSession = bucket.sessions[bucket.sessions.length - 1];
          const firstSessionMs = firstSession.startMs;
          const raceSession = bucket.sessions.find(s => s.name === 'Race') || lastSession;

          // Only include race weekends that haven't fully ended yet
          if (raceSession.startMs <= now.getTime()) continue;

          // Extract country from circuit location string (last segment after comma)
          const locParts = bucket.circuit.split(',').map((p: string) => p.trim());
          const country = locParts.length > 1 ? locParts[locParts.length - 1] : locParts[0];

          allRaces.push({
            category: 'f1',
            title: bucket.raceName,
            venue: bucket.circuit,
            event_date: new Date(firstSessionMs).toISOString(),
            event_end: new Date(raceSession.startMs).toISOString(),
            location: bucket.circuit,
            ticket_url: null,
            source: 'ical',
            image_url: null,
            metadata: {
              circuit: bucket.circuit,
              country,
              flag: F1_FLAGS[country] || '🏁',
              sessions: bucket.sessions.map(s => ({ name: s.name, date: s.date, time: s.time })),
            },
          });
        }

        console.log(`[syncF1] iCal: ${allRaces.length} F1 race weekends parsed from ${icalUrl}`);
        if (allRaces.length > 0) {
          f1IcalSuccess = true;
          break;
        }
      } catch (icalErr: any) {
        console.warn(`[syncF1] iCal fetch/parse error for ${icalUrl}:`, icalErr.message);
      }
    }

    // Fallback: Ergast/jolpica F1 API if iCal failed
    // This produces one race-centric row per race weekend with metadata.sessions
    if (!f1IcalSuccess) {
      console.log('[syncF1] iCal feeds failed — falling back to Ergast API...');
      for (const year of [currentYear, currentYear + 1]) {
        try {
          console.log(`[syncF1] Fetching F1 schedule for ${year} from Ergast API...`);
          const ergastRes = await fetchT(`https://api.jolpi.ca/ergast/f1/${year}.json`, {}, 15_000);
          if (!ergastRes.ok) {
            console.warn(`[syncF1] Ergast API failed for ${year}: HTTP ${ergastRes.status} ${ergastRes.statusText}`);
            continue;
          }
          const ergastData = await ergastRes.json();
          const races: any[] = ergastData?.MRData?.RaceTable?.Races || [];
          console.log(`[syncF1] Ergast: ${races.length} races for ${year}`);
          for (const race of races) {
            const raceDateStr = race.date;
            const raceTimeStr = race.time || '14:00:00Z';
            if (!raceDateStr) continue;
            const raceDate = new Date(`${raceDateStr}T${raceTimeStr}`);
            if (raceDate <= now) continue;

            const circuit = race.Circuit?.circuitName || 'F1 Circuit';
            const locality = race.Circuit?.Location?.locality || '';
            const country = race.Circuit?.Location?.country || '';
            const location = [locality, country].filter(Boolean).join(', ') || 'Global';

            const sessions: Array<{ name: string; date: string; time: string }> = [];
            if (race.FirstPractice) sessions.push({ name: 'Practice 1', date: race.FirstPractice.date, time: race.FirstPractice.time || '10:00:00Z' });
            if (race.SecondPractice) sessions.push({ name: 'Practice 2', date: race.SecondPractice.date, time: race.SecondPractice.time || '10:00:00Z' });
            if (race.SprintQualifying) sessions.push({ name: 'Sprint Qualifying', date: race.SprintQualifying.date, time: race.SprintQualifying.time || '10:00:00Z' });
            if (race.Sprint) sessions.push({ name: 'Sprint Race', date: race.Sprint.date, time: race.Sprint.time || '10:00:00Z' });
            if (race.ThirdPractice) sessions.push({ name: 'Practice 3', date: race.ThirdPractice.date, time: race.ThirdPractice.time || '10:00:00Z' });
            if (race.Qualifying) sessions.push({ name: 'Qualifying', date: race.Qualifying.date, time: race.Qualifying.time || '10:00:00Z' });
            sessions.push({ name: 'Race', date: raceDateStr, time: raceTimeStr });
            sessions.sort((a, b) => new Date(`${a.date}T${a.time}`).getTime() - new Date(`${b.date}T${b.time}`).getTime());

            const firstSession = sessions[0];
            const firstSessionDate = firstSession ? `${firstSession.date}T${firstSession.time}` : raceDate.toISOString();

            allRaces.push({
              category: 'f1',
              title: race.raceName,
              venue: circuit,
              event_date: firstSessionDate,
              event_end: raceDate.toISOString(),
              location,
              ticket_url: null,
              source: 'ergast',
              image_url: null,
              metadata: {
                circuit,
                country,
                flag: F1_FLAGS[country] || F1_FLAGS[locality] || '🏁',
                sessions,
              },
            });
          }
        } catch (yearErr: any) {
          console.warn(`[syncF1] Ergast fetch error for ${year}:`, yearErr.message);
        }
      }
    }

    console.log(`[syncF1] Total: ${allRaces.length} upcoming F1 race weekends`);

    // Supplement: Try Ticketmaster to enrich race weekend events with ticket URLs
    const tmKey = process.env.TICKETMASTER_API_KEY;
    if (tmKey && allRaces.length > 0) {
      const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
      const endDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z/, 'Z');
      const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${tmKey}&keyword=Formula+1&size=50&sort=date,asc&startDateTime=${startDate}&endDateTime=${endDate}`;
      try {
        const tmRes = await fetchT(tmUrl, {}, 15_000);
        if (tmRes.ok) {
          const tmData = await tmRes.json();
          const tmEvents = tmData?._embedded?.events || [];
          console.log(`[syncF1] Ticketmaster: ${tmEvents.length} F1 events found for ticket URL enrichment`);
          const tmMap = new Map<string, string>();
          for (const evt of tmEvents) {
            const dateStr = evt.dates?.start?.dateTime || evt.dates?.start?.localDate;
            if (dateStr && evt.url) {
              const key = new Date(dateStr).toISOString().split('T')[0];
              tmMap.set(key, evt.url);
            }
          }
          for (const race of allRaces) {
            // Match by race weekend date (event_end = race day date)
            const raceKey = race.event_end ? race.event_end.split('T')[0] : race.event_date.split('T')[0];
            if (tmMap.has(raceKey)) race.ticket_url = tmMap.get(raceKey)!;
          }
        } else {
          const errBody = await tmRes.text().catch(() => '');
          console.warn(`[syncF1] Ticketmaster failed: HTTP ${tmRes.status} — ${errBody.slice(0, 200)}`);
        }
      } catch (tmErr: any) {
        console.warn('[syncF1] Ticketmaster error:', tmErr.message);
      }
    } else if (!tmKey) {
      console.warn('[syncF1] TICKETMASTER_API_KEY not configured — skipping ticket URL enrichment');
    }

    // Last resort: Ticketmaster as raw event source if all else failed
    if (allRaces.length === 0 && tmKey) {
      console.log('[syncF1] No races from iCal/Ergast — falling back to Ticketmaster for event list...');
      const startDate = now.toISOString().replace(/\.\d{3}Z/, 'Z');
      const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${tmKey}&keyword=Formula+1&size=50&sort=date,asc&startDateTime=${startDate}`;
      try {
        const tmRes = await fetchT(tmUrl, {}, 15_000);
        if (!tmRes.ok) {
          const errBody = await tmRes.text().catch(() => '');
          console.warn(`[syncF1] Ticketmaster fallback failed: HTTP ${tmRes.status} — ${errBody.slice(0, 200)}`);
        } else {
          const tmData = await tmRes.json();
          const tmEvents = tmData?._embedded?.events || [];
          console.log(`[syncF1] Ticketmaster fallback: ${tmEvents.length} raw events`);
          for (const evt of tmEvents) {
            if (!evt.name) continue;
            const dateStr = evt.dates?.start?.dateTime || evt.dates?.start?.localDate;
            if (!dateStr) continue;
            const eventDate = new Date(dateStr);
            if (eventDate <= now) continue;
            const venueObj = evt._embedded?.venues?.[0];
            const city = venueObj?.city?.name || '';
            const country = venueObj?.country?.name || '';
            allRaces.push({
              category: 'f1', title: evt.name,
              venue: venueObj?.name || 'F1 Circuit',
              event_date: eventDate.toISOString(),
              location: [city, country].filter(Boolean).join(', ') || 'Global',
              ticket_url: evt.url || null, source: 'ticketmaster',
              image_url: pickBestImage(evt.images || []),
              metadata: { circuit: venueObj?.name || '', country, flag: F1_FLAGS[country] || '🏁', sessions: [] },
            });
          }
        }
      } catch (tmFallbackErr: any) {
        console.warn('[syncF1] Ticketmaster fallback error:', tmFallbackErr.message);
      }
    }

    if (allRaces.length === 0) {
      console.warn('[syncF1] No F1 events found from any source — preserving existing data');
      return { synced: 0, note: 'No F1 events found from iCal, Ergast, or Ticketmaster — existing data preserved' };
    }

    // Deduplicate by normalized race name + race date to avoid cross-season collisions
    const seen = new Set<string>();
    const unique = allRaces.filter(r => {
      const raceDay = (r.event_end || r.event_date).split('T')[0];
      const key = `${normalizeForDedup(r.title).slice(0, 25)}|${raceDay}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log(`[syncF1] ${allRaces.length} raw → ${unique.length} unique race weekends — replacing DB records`);

    // Transactional safe-swap
    const client = await pool.connect();
    let synced = 0;
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM entertainment_events WHERE category = 'f1' AND event_date >= $1`, [now.toISOString()]);
      for (const race of unique) {
        await client.query(
          `INSERT INTO entertainment_events (category, title, venue, event_date, event_end, location, ticket_url, metadata, source, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [race.category, race.title, race.venue, race.event_date, race.event_end || null, race.location, race.ticket_url, JSON.stringify(race.metadata || {}), race.source, race.image_url || null]
        );
        synced++;
      }
      await client.query('COMMIT');
    } catch (txErr: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[syncF1] Transaction failed, rolled back:', txErr.message);
      throw txErr;
    } finally {
      client.release();
    }
    console.log(`[syncF1] Inserted ${synced} F1 race weekends`);
    return { synced, sources: { ical: allRaces.filter(r => r.source === 'ical').length, ergast: allRaces.filter(r => r.source === 'ergast').length, ticketmaster: allRaces.filter(r => r.source === 'ticketmaster').length } };
  } catch (e: any) {
    console.error('[syncF1] Unexpected error:', e.message);
    return { error: e.message };
  }
}

router.post('/api/entertainment-sync', async (req: any, res: any) => {
  try {
    const action = req.body?.action || 'all';
    const results: Record<string, unknown> = {};
    const db = storage;
    const t0 = Date.now();
    if (action === 'lakers' || action === 'all') results.lakers = await syncLakers(db);
    if (action === 'f1' || action === 'all') results.f1 = await syncF1(db);
    if (action === 'concerts' || action === 'all') results.concerts = await syncConcerts(db);
    if (action === 'broadway' || action === 'shows' || action === 'all') results.shows = await syncShows(db);

    // Post-sync verification: log count of future events per synced category
    const now = new Date().toISOString();
    const categoriesToCheck: string[] = [];
    if (action === 'lakers' || action === 'all') categoriesToCheck.push('lakers');
    if (action === 'f1' || action === 'all') categoriesToCheck.push('f1');
    if (action === 'concerts' || action === 'all') categoriesToCheck.push('concert');
    if (action === 'broadway' || action === 'shows' || action === 'all') categoriesToCheck.push('shows', 'broadway');
    let countSummary = '';
    if (categoriesToCheck.length > 0) {
      const { rows } = await db.query(
        `SELECT category, COUNT(*) as cnt FROM entertainment_events WHERE category = ANY($1) AND event_date >= $2 GROUP BY category`,
        [categoriesToCheck, now]
      );
      countSummary = rows.map((r: any) => `${r.category}=${r.cnt}`).join(', ') || 'none';
      console.log(`[entertainment-sync] Post-sync future event counts:`, countSummary);
    }

    const totalSynced = Object.values(results).reduce((sum: number, r: any) => sum + (r?.synced || 0), 0);

    // Log per-category errors clearly
    for (const [cat, result] of Object.entries(results)) {
      if ((result as any)?.error) {
        console.warn(`[entertainment-sync] ${cat} error: ${(result as any).error}`);
      }
    }

    logAudit('entertainment-sync', {
      category: 'media', event_type: 'entertainment_sync', severity: 'info',
      actor_id: 'system', actor_name: 'Cron', actor_role: 'system',
      channel: 'cron', summary: `Entertainment sync (${action}) complete — ${totalSynced} events synced`,
      detail: { action, results, future_counts: countSummary }, duration_ms: Date.now() - t0, status: 'success',
    });

    res.json({ success: true, results });
  } catch (err: any) {
    console.error('entertainment-sync error:', err.message);
    logAudit('entertainment-sync', {
      category: 'media', event_type: 'entertainment_sync_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Entertainment sync failed: ${err.message}`,
      status: 'error',
    });
    res.status(500).json({ error: err.message });
  }
});

const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w500';

async function tmdbGet(path: string, bearerToken?: string, apiKey?: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  if (apiKey) url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  const res = await fetchT(url.toString(), { headers });
  if (!res.ok) throw new Error(`TMDB API error: ${res.status} ${res.statusText}`);
  return res.json();
}

router.post('/api/media-sync', async (req: any, res: any) => {
  try {
    const bearerToken = process.env.TMDB_READ_ACCESS_TOKEN;
    const apiKey = process.env.TMDB_API_KEY;
    const rapidApiKey = process.env.RAPIDAPI_KEY;
    if (!bearerToken && !apiKey) {
      console.log('[media-sync] TMDB token not configured — skipping.');
      return res.json({ skipped: true, reason: 'Neither TMDB_READ_ACCESS_TOKEN nor TMDB_API_KEY configured' });
    }
    const action = req.body?.action || 'all';
    const results: Record<string, unknown> = {};
    const db = storage;

    const enrichWithRapidAPI = async (categories: string[]) => {
      if (!rapidApiKey) return { skipped: true, reason: 'RAPIDAPI_KEY not configured' };
      try {
        const { rows: items } = await db.query(`SELECT id, title, category, rating, metadata FROM media_items WHERE category = ANY($1)`, [categories]);
        if (!items?.length) return { enriched: 0 };
        const unenriched = items.filter((item: any) => !(item.metadata as any)?.imdb_rating);
        if (unenriched.length === 0) return { enriched: 0, skipped: items.length, reason: 'already enriched' };
        let enriched = 0, failed = 0;
        for (let i = 0; i < unenriched.length; i++) {
          const item = unenriched[i];
          try {
            const searchUrl = `https://imdb188.p.rapidapi.com/api/v1/searchIMDB?query=${encodeURIComponent(item.title)}`;
            const searchRes = await fetchT(searchUrl, { headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'imdb188.p.rapidapi.com' } });
            const searchData = await searchRes.json();
            const imdbId = searchData.data?.[0]?.id;
            if (imdbId) {
              const detailUrl = `https://imdb188.p.rapidapi.com/api/v1/getIMDBDetails?imdbId=${imdbId}`;
              const detailRes = await fetchT(detailUrl, { headers: { 'X-RapidAPI-Key': rapidApiKey, 'X-RapidAPI-Host': 'imdb188.p.rapidapi.com' } });
              const detailData = await detailRes.json();
              const rating = detailData.data?.ratings?.aggregateRating;
              if (rating) {
                const newMetadata = { ...(item.metadata as any), imdb_id: imdbId, imdb_rating: rating };
                await db.query(`UPDATE media_items SET metadata = $1, score = $2 WHERE id = $3`, [JSON.stringify(newMetadata), rating, item.id]);
                enriched++;
              }
            }
          } catch (e) { failed++; }
          if (i + 3 < unenriched.length) await new Promise(r => setTimeout(r, 350));
        }
        return { enriched, failed, total: unenriched.length };
      } catch (e: any) { return { error: String(e) }; }
    }

    const syncTheaters = async () => {
      try {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const seventyDaysAgo = new Date(); seventyDaysAgo.setDate(seventyDaysAgo.getDate() - 70);
        const fortyFiveDaysAgoStr = seventyDaysAgo.toISOString().split('T')[0];
        const [nowPlayingData, discoverPage1, discoverPage2] = await Promise.all([
          tmdbGet('/movie/now_playing', bearerToken, apiKey, { region: 'US', page: '1' }),
          tmdbGet('/discover/movie', bearerToken, apiKey, { sort_by: 'popularity.desc', region: 'US', with_release_type: '3|2', 'release_date.gte': fortyFiveDaysAgoStr, 'release_date.lte': todayStr, 'vote_count.gte': '10', page: '1' }),
          tmdbGet('/discover/movie', bearerToken, apiKey, { sort_by: 'popularity.desc', region: 'US', with_release_type: '3|2', 'release_date.gte': fortyFiveDaysAgoStr, 'release_date.lte': todayStr, 'vote_count.gte': '10', page: '2' }),
        ]);
        const allMovieMap = new Map<number, any>();
        for (const source of [nowPlayingData.results || [], discoverPage1.results || [], discoverPage2.results || []]) {
          for (const m of source) { if (!m.adult && m.release_date && !allMovieMap.has(m.id)) allMovieMap.set(m.id, m); }
        }
        let finalMovies = Array.from(allMovieMap.values()).sort((a, b) => (b.popularity || 0) - (a.popularity || 0)).slice(0, 20);
        const now = new Date().toISOString();
        const items = finalMovies.map((m: any, i: number) => ({
          category: 'theater', title: m.title, description: m.overview || null,
          release_date: m.release_date || null, poster_url: m.poster_path ? `${TMDB_IMAGE}${m.poster_path}` : null,
          score: m.vote_average ? parseFloat(m.vote_average.toFixed(1)) : null, rank: i + 1,
          metadata: { tmdb_id: m.id, kids: m.genre_ids?.includes(10751) || false }, source: 'tmdb', last_fetched_at: now,
        }));
        await db.query(`DELETE FROM media_items WHERE category = 'theater'`);
        if (items.length === 0) return { synced: 0 };
        for (const item of items) {
          await db.query(
            `INSERT INTO media_items (category, title, description, release_date, poster_url, score, rank, metadata, source, last_fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [item.category, item.title, item.description, item.release_date, item.poster_url, item.score, item.rank, JSON.stringify(item.metadata), item.source, item.last_fetched_at]
          );
        }
        return { synced: items.length };
      } catch (e: any) { return { error: e.message }; }
    }

    const syncStreaming = async (type: 'movie' | 'tv') => {
      try {
        const categories = type === 'movie' ? ['streaming_movie', 'kids_movie'] : ['streaming_show', 'kids_show'];
        await db.query(`DELETE FROM media_items WHERE category = ANY($1)`, [categories]);
        const providers = [8, 15, 337, 350, 9, 384];
        const now = new Date().toISOString();
        let allItems: any[] = [];
        for (const providerId of providers) {
          const data = await tmdbGet(`/discover/${type}`, bearerToken, apiKey, { sort_by: 'popularity.desc', watch_region: 'US', with_watch_providers: String(providerId) });
          const movies = (data.results || []).slice(0, 15).map((m: any) => ({
            category: m.genre_ids?.includes(10751) || m.genre_ids?.includes(10762) ? categories[1] : categories[0],
            title: m.title || m.name, description: m.overview || null,
            release_date: m.release_date || m.first_air_date || null,
            poster_url: m.poster_path ? `${TMDB_IMAGE}${m.poster_path}` : null,
            score: m.vote_average ? parseFloat(m.vote_average.toFixed(1)) : null,
            metadata: { tmdb_id: m.id, provider_id: providerId }, source: 'tmdb', last_fetched_at: now,
          }));
          allItems = [...allItems, ...movies];
        }
        allItems.sort((a, b) => (b.score || 0) - (a.score || 0));
        const seen = new Set();
        const finalItems = allItems.filter(item => { if (seen.has(item.metadata.tmdb_id)) return false; seen.add(item.metadata.tmdb_id); return true; }).slice(0, 60);
        for (const item of finalItems) {
          await db.query(
            `INSERT INTO media_items (category, title, description, release_date, poster_url, score, rank, metadata, source, last_fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [item.category, item.title, item.description, item.release_date, item.poster_url, item.score, null, JSON.stringify(item.metadata), item.source, item.last_fetched_at]
          );
        }
        return { synced: finalItems.length };
      } catch (e: any) { return { error: e.message }; }
    }

    const t0 = Date.now();
    if (action === 'theater' || action === 'all') results.theater = await syncTheaters();
    if (action === 'streaming' || action === 'all') {
      results.streaming_movies = await syncStreaming('movie');
      results.streaming_tv = await syncStreaming('tv');
    }
    if (action === 'enrich' || action === 'all') {
      results.enrichment = await enrichWithRapidAPI(['theater', 'streaming_movie', 'streaming_show']);
    }

    const totalSynced = ['theater', 'streaming_movies', 'streaming_tv'].reduce((sum: number, key) => sum + ((results[key] as any)?.synced || 0), 0);
    logAudit('media-sync', {
      category: 'media', event_type: 'media_sync', severity: 'info',
      actor_id: 'system', actor_name: 'Cron', actor_role: 'system',
      channel: 'cron', summary: `Media sync (${action}) complete — ${totalSynced} titles synced`,
      detail: { action, results }, duration_ms: Date.now() - t0, status: 'success',
    });

    res.json({ success: true, results });
  } catch (err: any) {
    console.error('media-sync error:', err.message);
    logAudit('media-sync', {
      category: 'media', event_type: 'media_sync_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Media sync failed: ${err.message}`,
      status: 'error',
    });
    res.status(500).json({ error: err.message });
  }
});

export default router;
