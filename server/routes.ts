import type { Express, Request, Response, NextFunction } from "express";
import authRoutes from "./routes/auth";
import proxyRoutes from "./routes/proxy";
import janusRoutes from "./routes/janus";
import productivityRoutes from "./routes/productivity";
import homeAssistantRoutes from './routes/homeAssistant';
import goveeRoutes from './routes/govee';
import teslaRoutes from './routes/tesla';
import verkadaRoutes from './routes/verkada';
import poolRoutes from './routes/pool';
import generacRoutes from './routes/generac';
import automationRoutes from './routes/automation';
import energySavingsRoutes from './routes/energySavings';
import googleRoutes from './routes/google';
import calendarRoutes from './routes/calendar';
import notionRoutes from './routes/notion';
import broadcastRoutes from './routes/broadcast';
import followupRoutes from './routes/followup';
import reportsRoutes from './routes/reports';
import entertainmentRoutes from './routes/entertainment';
import weatherRoutes from './routes/weather';
import monitoringRoutes from './routes/monitoring';
import scrapingRoutes from './routes/scraping';
import shoppingRoutes from './routes/shopping';
import groceryRoutes from './routes/grocery';
import adminRoutes from './routes/admin';
import travelRoutes from './routes/travel';
import dataRoutes from './routes/data';
import perplexityRoutes from './routes/perplexity';
import fortigateRoutes from './routes/fortigate';
import wirelessRoutes from './routes/wireless';
import networkDevicesRoutes from './routes/network-devices';
import computerAuthRoutes from './routes/computerAuth.js';
import goaccessRoutes from './routes/goaccess';
import externalRoutes from './routes/external';
import deployRoutes from './routes/deploy';
import electricityRoutes from './routes/electricity';
import waterRoutes from './routes/water';
import storageCompatRoutes from './routes/storage-compat';
import updatesAutogenRoutes from './routes/updates-autogen';
import irrigationRoutes from './routes/irrigation';
import timeRoutes from './routes/time';
import { rejectWorkers } from './middleware/auth.js';

const SUPABASE_COMPAT_MAP: Record<string, string> = {
  'home-assistant-proxy': '/api/home-assistant',
  'verkada-proxy': '/api/verkada',
  'iaqualink-proxy': '/api/pool',
  'tesla-proxy': '/api/tesla',
  'tesla-setup': '/api/tesla/setup',
  'google-auth': '/api/google/auth',
  'google-calendar-proxy': '/api/google/calendar',
  'google-environment-proxy': '/api/google/environment',
  'notion-proxy': '/api/notion/proxy',
  'notion-webhook': '/api/notion/webhook',
  'janus-chat': '/api/janus/chat',
  'janus-email-poll': '/api/janus/email-poll',
  'janus-whatsapp': '/api/janus/whatsapp',
  'janus-research-worker': '/api/janus/research-worker',
  'janus-media-worker': '/api/janus/media-worker',
  'janus-reminder-dispatch': '/api/janus/reminder-dispatch',
  'janus-email': '/api/janus/email',
  'janus-health-check': '/api/janus/health-check',
  'janus-functional-test': '/api/janus/functional-test',
  'tesla-battery-monitor': '/api/tesla/battery-monitor',
  'weather-dashboard': '/api/weather-dashboard',
  'nba-game-proxy': '/api/nba-game-proxy',
  'firecrawl-search': '/api/firecrawl-search',
  'entertainment-sync': '/api/entertainment-sync',
  'showtimes-proxy': '/api/showtimes-proxy',
  'ai-movie-recommender': '/api/ai-movie-recommender',
  'grocery-order': '/api/grocery-order',
  'travel-email-scanner': '/api/travel-email-scanner',
  'trip-document-upload': '/api/trip-document-upload',
  'generac-proxy': '/api/generac',
  'elevenlabs-voice': '/api/broadcast/elevenlabs-voice',
  'credential-vault': '/api/credential-vault',
};

function supabaseCompatMiddleware(req: Request, _res: Response, next: NextFunction) {
  const match = req.path.match(/^\/functions\/v1\/(.+)/);
  if (match) {
    const fnName = match[1].split('?')[0];
    const mapped = SUPABASE_COMPAT_MAP[fnName];
    if (mapped) {
      req.url = mapped + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    } else {
      req.url = `/api/${fnName}` + (req.url.includes('?') ? '?' + req.url.split('?')[1] : '');
    }
  }
  next();
}

export async function registerRoutes(app: Express): Promise<void> {
  app.use(storageCompatRoutes);
  app.use(supabaseCompatMiddleware);

  // Time tracking routes — must be registered BEFORE rejectWorkers so workers
  // can reach /api/time/* without being blocked by the fence.
  app.use(timeRoutes);

  // Global worker fence — blocks worker-role tokens from all non-time/auth routes.
  app.use(rejectWorkers);

  app.use(authRoutes);
  app.use(proxyRoutes);
  app.use(productivityRoutes);
  app.use(adminRoutes);
  app.use(entertainmentRoutes);
  app.use(shoppingRoutes);
  app.use(travelRoutes);
  app.use(weatherRoutes);
  app.use(scrapingRoutes);
  app.use(monitoringRoutes);
  app.use(energySavingsRoutes);
  app.use(groceryRoutes);
  app.use(dataRoutes);
  app.use(updatesAutogenRoutes);
  app.use(computerAuthRoutes);

  app.use('/api/home-assistant', homeAssistantRoutes);
  app.use('/api/govee', goveeRoutes);
  app.use('/api/tesla', teslaRoutes);
  app.use('/api/verkada', verkadaRoutes);
  app.use('/api/pool', poolRoutes);
  app.use('/api/generac', generacRoutes);
  app.use('/api/automation', automationRoutes);
  app.use('/api/google', googleRoutes);
  app.use('/api/calendar', calendarRoutes);
  app.use('/api/notion', notionRoutes);
  app.use('/api/broadcast', broadcastRoutes);
  app.use('/api/followup', followupRoutes);
  app.use('/api/reports', reportsRoutes);

  app.use('/api/perplexity', perplexityRoutes);
  app.use('/api/janus', janusRoutes);
  app.use(fortigateRoutes);
  app.use(irrigationRoutes);
  app.use(wirelessRoutes);
  app.use(networkDevicesRoutes);
  app.use('/api/goaccess', goaccessRoutes);
  app.use('/api/electricity', electricityRoutes);
  app.use('/api/water', waterRoutes);
  app.use('/api/v1/external', externalRoutes);
  app.use(deployRoutes);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });
}
