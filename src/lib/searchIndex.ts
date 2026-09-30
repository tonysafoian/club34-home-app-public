export interface SearchEntry {
  id: string;
  title: string;
  description: string;
  category: 'Page' | 'Feature' | 'System' | 'Action' | 'Admin';
  path: string;
  hash?: string;
  keywords: string[];
  icon: string;
  adminOnly?: boolean;
}

export const SEARCH_INDEX: SearchEntry[] = [
  // ── Pages ──────────────────────────────────────────────────────────
  {
    id: 'dashboard',
    title: 'Dashboard',
    description: 'Home screen with productivity, calendar, and daily overview',
    category: 'Page',
    path: '/',
    keywords: ['home', 'dashboard', 'main', 'overview', 'start', 'hub'],
    icon: 'LayoutDashboard',
  },
  {
    id: 'security',
    title: 'Security',
    description: 'Security overview, activity log, and access controls',
    category: 'Page',
    path: '/security',
    keywords: ['security', 'alarm', 'access', 'log', 'events', 'motion', 'alert'],
    icon: 'Shield',
  },
  {
    id: 'security-cameras',
    title: 'Security Cameras',
    description: 'Live camera feeds and Verkada video surveillance',
    category: 'Page',
    path: '/security/cameras',
    keywords: ['cameras', 'verkada', 'cctv', 'video', 'live feed', 'surveillance', 'footage'],
    icon: 'Camera',
  },
  {
    id: 'teslas',
    title: 'Tesla Vehicles',
    description: 'Vehicle status, battery, charging, location, and controls',
    category: 'Feature',
    path: '/home-systems',
    hash: 'vehicles',
    keywords: ['tesla', 'car', 'vehicle', 'ev', 'electric', 'charge', 'battery', 'range', 'drive', 'lock', 'unlock', 'horn', 'trunk'],
    icon: 'Car',
  },
  {
    id: 'home-systems',
    title: 'Systems',
    description: 'Pool, spa, garage, sauna, and smart home systems',
    category: 'Page',
    path: '/home-systems',
    keywords: ['home', 'systems', 'smart home', 'controls', 'devices'],
    icon: 'Home',
  },
  {
    id: 'family',
    title: 'Family',
    description: 'Family calendar, travel, entertainment, and events',
    category: 'Page',
    path: '/family',
    keywords: ['family', 'kids', 'children', 'schedule', 'events', 'household'],
    icon: 'Users',
  },
  {
    id: 'automations',
    title: 'Automations',
    description: 'Scheduled automations, email bots, scrapers, and Janus health',
    category: 'Page',
    path: '/automations',
    keywords: ['automation', 'bot', 'scheduled', 'cron', 'email', 'workflow'],
    icon: 'Zap',
  },
  {
    id: 'activity',
    title: 'Activity Log',
    description: 'Full event history across all systems and sources',
    category: 'Page',
    path: '/activity',
    keywords: ['activity', 'log', 'history', 'events', 'timeline', 'audit'],
    icon: 'Activity',
  },
  {
    id: 'weather',
    title: 'Weather',
    description: 'Current conditions, forecast, and weather details',
    category: 'Page',
    path: '/weather',
    keywords: ['weather', 'forecast', 'temperature', 'rain', 'sun', 'wind', 'humidity'],
    icon: 'Cloud',
  },
  {
    id: 'settings',
    title: 'Settings',
    description: 'App configuration, integrations, and account settings',
    category: 'Page',
    path: '/settings',
    keywords: ['settings', 'config', 'account', 'preferences', 'profile', 'setup'],
    icon: 'Settings',
  },
  {
    id: 'common-tasks-amazon',
    title: 'Find Something on Amazon & Order',
    description: 'Search for a product on Amazon and place an order',
    category: 'Page',
    path: '/common-tasks/amazon',
    keywords: ['tasks', 'common', 'amazon', 'order', 'shopping', 'buy', 'purchase'],
    icon: 'ShoppingCart',
  },

  {
    id: 'admin',
    title: 'Admin Panel',
    description: 'System administration, users, and configuration',
    category: 'Admin',
    path: '/admin',
    keywords: ['admin', 'administration', 'manage', 'control panel'],
    icon: 'Terminal',
    adminOnly: true,
  },

  // ── Dashboard Sections ─────────────────────────────────────────────
  {
    id: 'dashboard-productivity',
    title: 'Productivity',
    description: 'Daily tasks, Google Calendar events, and to-do items',
    category: 'Feature',
    path: '/',
    hash: 'productivity',
    keywords: ['productivity', 'tasks', 'todo', 'to-do', 'work', 'focus'],
    icon: 'CheckSquare',
  },
  {
    id: 'dashboard-calendar',
    title: 'Google Calendar',
    description: 'Upcoming events from your Google Calendar',
    category: 'Feature',
    path: '/',
    hash: 'calendar',
    keywords: ['calendar', 'google', 'events', 'meetings', 'appointments', 'schedule'],
    icon: 'Calendar',
  },
  {
    id: 'dashboard-today',
    title: 'Today View',
    description: "What's happening today at Janus",
    category: 'Feature',
    path: '/',
    hash: 'today',
    keywords: ['today', 'now', 'current', 'daily', 'morning'],
    icon: 'Sun',
  },
  {
    id: 'dashboard-looking-ahead',
    title: 'Looking Ahead',
    description: 'Upcoming events and reminders for the coming days',
    category: 'Feature',
    path: '/',
    hash: 'looking-ahead',
    keywords: ['upcoming', 'future', 'next week', 'ahead', 'planning', 'reminders'],
    icon: 'TrendingUp',
  },
  {
    id: 'dashboard-weather-strip',
    title: 'Weather Strip',
    description: 'Quick weather summary on the dashboard',
    category: 'Feature',
    path: '/',
    keywords: ['weather', 'temperature', 'quick', 'strip'],
    icon: 'Thermometer',
  },

  // ── Security Features ──────────────────────────────────────────────
  {
    id: 'verkada-people',
    title: 'People Tracker',
    description: 'Track and identify people seen by Verkada cameras',
    category: 'Feature',
    path: '/security',
    hash: 'people',
    keywords: ['people', 'person', 'face', 'identify', 'track', 'visitor', 'stranger', 'verkada'],
    icon: 'UserSearch',
  },
  {
    id: 'verkada-daily',
    title: 'Daily Tracker',
    description: 'Daily summary of who was detected at the property',
    category: 'Feature',
    path: '/security',
    hash: 'daily',
    keywords: ['daily', 'tracker', 'summary', 'detection', 'yesterday', 'today'],
    icon: 'CalendarDays',
  },
  {
    id: 'admin-people-tracker',
    title: 'People Tracker',
    description: 'Face-recognized persons of interest tracked across all cameras',
    category: 'Feature',
    path: '/admin',
    hash: 'people-tracker',
    keywords: ['people', 'tracker', 'face', 'recognition', 'sightings', 'cameras', 'poi', 'enter', 'exit'],
    icon: 'Users',
    adminOnly: true,
  },
  {
    id: 'outsider-logs',
    title: 'Outsider Logs',
    description: 'Logs of unrecognized or external visitors',
    category: 'Admin',
    path: '/admin',
    hash: 'outsider-logs',
    keywords: ['outsider', 'unknown', 'stranger', 'visitor', 'external', 'unrecognized'],
    icon: 'UserX',
    adminOnly: true,
  },

  // ── Tesla Features ─────────────────────────────────────────────────
  {
    id: 'tesla-battery',
    title: 'Tesla Battery & Range',
    description: 'Current battery level and estimated driving range',
    category: 'Feature',
    path: '/home-systems',
    hash: 'vehicles',
    keywords: ['battery', 'charge', 'range', 'miles', 'percent', 'soc', 'charging'],
    icon: 'Battery',
  },
  {
    id: 'tesla-location',
    title: 'Tesla Location & Map',
    description: 'Live vehicle location on a map',
    category: 'Feature',
    path: '/home-systems',
    hash: 'vehicles',
    keywords: ['location', 'map', 'gps', 'where', 'parked', 'position', 'tracking'],
    icon: 'MapPin',
  },
  {
    id: 'tesla-battery-monitor',
    title: 'Tesla Battery Monitor',
    description: 'Automated alerts when battery drops below threshold',
    category: 'Feature',
    path: '/automations',
    keywords: ['tesla', 'battery monitor', 'alert', 'low battery', 'notification', 'automation'],
    icon: 'BatteryLow',
  },

  // ── Home Systems ───────────────────────────────────────────────────
  {
    id: 'pool',
    title: 'Pool',
    description: 'Pool controls — temperature, pump, lights, and chemistry',
    category: 'System',
    path: '/home-systems',
    keywords: ['pool', 'swim', 'water', 'pump', 'filter', 'chlorine', 'pH'],
    icon: 'Waves',
  },
  {
    id: 'spa',
    title: 'Spa / Hot Tub',
    description: 'Spa controls — temperature, jets, and heating',
    category: 'System',
    path: '/home-systems',
    keywords: ['spa', 'hot tub', 'jacuzzi', 'jets', 'soak', 'heat', 'relax'],
    icon: 'Droplets',
  },
  {
    id: 'iaqualink',
    title: 'iAqualink',
    description: 'Jandy iAqualink pool and spa control system',
    category: 'System',
    path: '/home-systems',
    keywords: ['iaqualink', 'aqualink', 'jandy', 'pool system', 'pool app'],
    icon: 'Waves',
  },
  {
    id: 'generac',
    title: 'Generac Generator',
    description: 'Backup generator status, power output, and fuel level',
    category: 'System',
    path: '/home-systems',
    keywords: ['generac', 'generator', 'backup power', 'power outage', 'fuel', 'watt', 'electric'],
    icon: 'Zap',
  },
  {
    id: 'myq',
    title: 'MyQ Garage',
    description: 'Garage door status and open/close controls',
    category: 'System',
    path: '/home-systems',
    keywords: ['myq', 'garage', 'door', 'open', 'close', 'driveway', 'car'],
    icon: 'Warehouse',
  },
  {
    id: 'sauna',
    title: 'Sauna / SaunaLogic',
    description: 'Sauna temperature control and scheduling',
    category: 'System',
    path: '/home-systems',
    keywords: ['sauna', 'saunalogic', 'heat', 'steam', 'sweat', 'temperature', 'wellness'],
    icon: 'Thermometer',
  },
  {
    id: 'crestron',
    title: 'Crestron',
    description: 'Crestron home automation and AV system status',
    category: 'System',
    path: '/home-systems',
    keywords: ['crestron', 'av', 'audio', 'video', 'automation', 'control', 'theater'],
    icon: 'Monitor',
  },

  // ── Family Features ────────────────────────────────────────────────
  {
    id: 'family-travel',
    title: 'Travel',
    description: 'Upcoming trips, flights, hotels, and itineraries',
    category: 'Feature',
    path: '/family',
    hash: 'travel',
    keywords: ['travel', 'trip', 'flight', 'hotel', 'vacation', 'itinerary', 'airport', 'booking'],
    icon: 'Plane',
  },
  {
    id: 'family-entertainment',
    title: 'Entertainment',
    description: 'Live events, concerts, sports, and shows',
    category: 'Feature',
    path: '/family',
    hash: 'entertainment',
    keywords: ['entertainment', 'events', 'concert', 'sports', 'show', 'ticket', 'live', 'game', 'nba', 'nfl'],
    icon: 'Music',
  },
  {
    id: 'family-movies',
    title: 'Movies & TV',
    description: 'Movie recommendations, streaming options, and what to watch',
    category: 'Feature',
    path: '/family',
    hash: 'movies',
    keywords: ['movies', 'tv', 'shows', 'streaming', 'netflix', 'watch', 'film', 'series', 'hulu', 'disney', 'hbo'],
    icon: 'Clapperboard',
  },
  {
    id: 'family-calendar',
    title: 'Family Calendar',
    description: 'Shared family events and scheduling',
    category: 'Feature',
    path: '/family',
    keywords: ['family calendar', 'schedule', 'events', 'shared'],
    icon: 'CalendarDays',
  },

  // ── Automations ────────────────────────────────────────────────────
  {
    id: 'morning-weather-email',
    title: 'Morning Weather Email',
    description: 'Automated daily weather summary sent each morning',
    category: 'Feature',
    path: '/automations',
    keywords: ['morning', 'weather email', 'daily email', 'briefing', 'newsletter', 'summary'],
    icon: 'Mail',
  },
  {
    id: 'janus-health',
    title: 'Janus Health Check',
    description: 'Monitor Janus AI assistant uptime and response status',
    category: 'Feature',
    path: '/automations',
    keywords: ['janus', 'health', 'status', 'uptime', 'monitor', 'ping', 'check'],
    icon: 'HeartPulse',
  },
  {
    id: 'email-logs',
    title: 'Email Logs',
    description: 'Log of all automated emails sent from the system',
    category: 'Feature',
    path: '/automations',
    keywords: ['email', 'logs', 'sent', 'outbox', 'history', 'smtp'],
    icon: 'Mail',
  },
  {
    id: 'janus-email-poll',
    title: 'Email Poll / Scanner',
    description: 'Automated scanning of incoming emails for travel and data',
    category: 'Feature',
    path: '/automations',
    keywords: ['email poll', 'scanner', 'inbox', 'parse', 'travel', 'booking'],
    icon: 'ScanSearch',
  },
  {
    id: 'firecrawl-scrape',
    title: 'Web Scraper',
    description: 'Scrape any web page content via Firecrawl',
    category: 'Feature',
    path: '/automations',
    keywords: ['scrape', 'firecrawl', 'crawl', 'web', 'extract', 'page', 'content'],
    icon: 'Globe',
  },
  {
    id: 'web-search',
    title: 'Web Search',
    description: 'Search the web via Firecrawl integration',
    category: 'Feature',
    path: '/automations',
    keywords: ['search', 'web search', 'google', 'internet', 'lookup', 'firecrawl'],
    icon: 'Search',
  },

  // ── Notion ─────────────────────────────────────────────────────────
  {
    id: 'notion',
    title: 'Notion',
    description: 'Notion databases, pages, webhooks, and sync management',
    category: 'Page',
    path: '/admin',
    hash: 'notion',
    keywords: ['notion', 'notes', 'database', 'pages', 'workspace', 'docs'],
    icon: 'FileText',
    adminOnly: true,
  },
  {
    id: 'notion-databases',
    title: 'Notion Databases',
    description: 'Manage and browse synced Notion databases',
    category: 'Feature',
    path: '/admin',
    hash: 'notion',
    keywords: ['notion database', 'tables', 'data', 'sync', 'picker'],
    icon: 'Database',
    adminOnly: true,
  },
  {
    id: 'notion-recurring',
    title: 'Recurring Tasks (Notion)',
    description: 'View and manage recurring tasks from Notion',
    category: 'Feature',
    path: '/admin',
    hash: 'notion',
    keywords: ['recurring', 'tasks', 'repeat', 'routine', 'weekly', 'daily', 'notion'],
    icon: 'RefreshCw',
    adminOnly: true,
  },
  {
    id: 'notion-webhooks',
    title: 'Notion Webhooks',
    description: 'Real-time Notion webhook events and triggers',
    category: 'Feature',
    path: '/admin',
    hash: 'notion',
    keywords: ['webhook', 'notion', 'trigger', 'event', 'real-time', 'push'],
    icon: 'Webhook',
    adminOnly: true,
  },

  // ── Admin ──────────────────────────────────────────────────────────
  {
    id: 'admin-users',
    title: 'User Management',
    description: 'Manage users, roles, approvals, and invitations',
    category: 'Admin',
    path: '/admin',
    hash: 'users',
    keywords: ['users', 'roles', 'admin', 'invite', 'approve', 'members', 'access', 'permissions'],
    icon: 'Users',
    adminOnly: true,
  },
  {
    id: 'admin-janus-access',
    title: 'Janus Access Control',
    description: 'Manage who can access Janus via WhatsApp and other channels',
    category: 'Admin',
    path: '/admin',
    hash: 'janus-access',
    keywords: ['janus', 'access', 'whatsapp', 'channel', 'group', 'whitelist', 'control'],
    icon: 'KeyRound',
    adminOnly: true,
  },
  {
    id: 'admin-prompts',
    title: 'Janus Soul',
    description: 'Edit Janus soul, personality, and AI behavior',
    category: 'Admin',
    path: '/admin',
    hash: 'prompts',
    keywords: ['soul', 'prompts', 'system prompt', 'ai', 'janus', 'behavior', 'instructions', 'persona', 'personality'],
    icon: 'HeartPulse',
    adminOnly: true,
  },
  {
    id: 'admin-suggestions',
    title: 'Suggestions',
    description: 'Feature requests and suggestions submitted by users',
    category: 'Admin',
    path: '/admin',
    hash: 'suggestions',
    keywords: ['suggestions', 'feedback', 'feature requests', 'ideas', 'wishlist'],
    icon: 'Lightbulb',
    adminOnly: true,
  },
  {
    id: 'admin-group-configs',
    title: 'Group Configs',
    description: 'Configure Janus WhatsApp group settings and tiers',
    category: 'Admin',
    path: '/admin',
    hash: 'group-configs',
    keywords: ['group', 'config', 'whatsapp', 'tier', 'settings', 'janus'],
    icon: 'Settings2',
    adminOnly: true,
  },
  {
    id: 'admin-household',
    title: 'Household Members',
    description: 'Manage household member profiles and aliases',
    category: 'Admin',
    path: '/admin',
    hash: 'household',
    keywords: ['household', 'members', 'family', 'profile', 'aliases', 'contacts'],
    icon: 'House',
    adminOnly: true,
  },

  // ── Settings ───────────────────────────────────────────────────────
  {
    id: 'settings-google',
    title: 'Google Services',
    description: 'Connect Google account for Calendar, Maps, and Gmail',
    category: 'Feature',
    path: '/settings',
    keywords: ['google', 'calendar', 'gmail', 'maps', 'oauth', 'connect', 'account'],
    icon: 'Globe',
  },
  {
    id: 'settings-home-assistant',
    title: 'Home Assistant',
    description: 'Connect and configure Home Assistant smart home hub',
    category: 'Feature',
    path: '/settings',
    keywords: ['home assistant', 'ha', 'smart home', 'lights', 'scenes', 'sensors', 'covers'],
    icon: 'Home',
  },
  {
    id: 'settings-amazon',
    title: 'Amazon Settings',
    description: 'Configure Amazon account for automated ordering',
    category: 'Feature',
    path: '/settings',
    keywords: ['amazon', 'settings', 'account', 'shopping', 'order', 'credentials'],
    icon: 'ShoppingBag',
  },
  {
    id: 'settings-credentials',
    title: 'Platform Credentials',
    description: 'Securely store platform usernames and passwords',
    category: 'Feature',
    path: '/settings',
    keywords: ['credentials', 'password', 'username', 'vault', 'secure', 'platform', 'login'],
    icon: 'KeyRound',
  },

  // ── Common Tasks ───────────────────────────────────────────────────
  {
    id: 'amazon-order',
    title: 'Amazon Order',
    description: 'Submit an Amazon order request for Janus to process',
    category: 'Action',
    path: '/common-tasks/amazon',
    keywords: ['amazon', 'order', 'buy', 'purchase', 'shop', 'cart', 'delivery'],
    icon: 'ShoppingCart',
  },

  {
    id: 'shopping-cart',
    title: 'Shopping Cart',
    description: 'View and manage your pending shopping cart items',
    category: 'Action',
    path: '/common-tasks/amazon',
    keywords: ['cart', 'shopping', 'list', 'items', 'buy', 'pending'],
    icon: 'ShoppingBag',
  },

  // ── Home Assistant Features ────────────────────────────────────────
  {
    id: 'ha-lights',
    title: 'Lights',
    description: 'Control smart lights and scenes via Home Assistant',
    category: 'System',
    path: '/home-systems',
    keywords: ['lights', 'lighting', 'bulb', 'lamp', 'dim', 'bright', 'smart light', 'home assistant'],
    icon: 'Lightbulb',
  },
  {
    id: 'ha-climate',
    title: 'Climate / Thermostat',
    description: 'Control thermostats and HVAC via Home Assistant',
    category: 'System',
    path: '/home-systems',
    keywords: ['climate', 'thermostat', 'hvac', 'ac', 'air conditioning', 'heat', 'temperature', 'cool'],
    icon: 'Thermometer',
  },
  {
    id: 'ha-covers',
    title: 'Covers & Blinds',
    description: 'Control window shades, blinds, and covers',
    category: 'System',
    path: '/home-systems',
    keywords: ['covers', 'blinds', 'shades', 'curtains', 'window', 'open', 'close'],
    icon: 'PanelLeft',
  },
  {
    id: 'ha-sensors',
    title: 'Sensors',
    description: 'Live sensor readings from Home Assistant — temperature, humidity, CO2',
    category: 'System',
    path: '/home-systems',
    keywords: ['sensors', 'temperature', 'humidity', 'co2', 'air quality', 'monitor', 'reading'],
    icon: 'Activity',
  },
  {
    id: 'ha-scenes',
    title: 'Scenes',
    description: 'Activate smart home scenes like Movie Mode or Good Morning',
    category: 'Action',
    path: '/home-systems',
    keywords: ['scenes', 'mood', 'movie mode', 'good morning', 'preset', 'automation', 'mode'],
    icon: 'Layers',
  },
  {
    id: 'ha-switches',
    title: 'Switches',
    description: 'Toggle smart switches and plugs via Home Assistant',
    category: 'System',
    path: '/home-systems',
    keywords: ['switches', 'plugs', 'outlets', 'toggle', 'on', 'off', 'smart plug'],
    icon: 'ToggleLeft',
  },
  {
    id: 'ha-logbook',
    title: 'HA Logbook',
    description: 'History of Home Assistant state changes and automations',
    category: 'Feature',
    path: '/home-systems',
    keywords: ['logbook', 'history', 'home assistant', 'events', 'state changes', 'log'],
    icon: 'ScrollText',
  },

  // ── Janus Features ─────────────────────────────────────────────────
  {
    id: 'janus-memory',
    title: 'Janus Memory',
    description: "Janus remembers your preferences and facts across sessions",
    category: 'Feature',
    path: '/',
    keywords: ['memory', 'janus', 'remember', 'facts', 'preferences', 'context', 'recall'],
    icon: 'Brain',
  },
  {
    id: 'janus-reminders',
    title: 'Janus Reminders',
    description: 'Set reminders with Janus — "remind me at 5pm to…"',
    category: 'Feature',
    path: '/',
    keywords: ['reminders', 'remind', 'alert', 'notify', 'timer', 'schedule', 'janus'],
    icon: 'Bell',
  },
  {
    id: 'janus-research',
    title: 'Janus Research',
    description: 'Janus can launch deep web research tasks in the background',
    category: 'Feature',
    path: '/',
    keywords: ['research', 'deep research', 'background', 'investigate', 'find', 'report', 'janus'],
    icon: 'Search',
  },
  {
    id: 'janus-voice',
    title: 'Voice Messages',
    description: 'Send and receive voice messages with Janus using push-to-talk',
    category: 'Feature',
    path: '/',
    keywords: ['voice', 'audio', 'speak', 'mic', 'microphone', 'push to talk', 'elevenlabs'],
    icon: 'Mic',
  },
  {
    id: 'janus-whatsapp',
    title: 'WhatsApp Integration',
    description: 'Chat with Janus directly via WhatsApp groups or direct messages',
    category: 'Feature',
    path: '/',
    keywords: ['whatsapp', 'wa', 'message', 'chat', 'mobile', 'phone', 'wati'],
    icon: 'MessageCircle',
  },

  // ── Install ────────────────────────────────────────────────────────
  {
    id: 'install-pwa',
    title: 'Install App',
    description: 'Install Janus as a PWA on your home screen',
    category: 'Action',
    path: '/install',
    keywords: ['install', 'pwa', 'app', 'home screen', 'add to home', 'mobile app', 'shortcut'],
    icon: 'Download',
  },
];

export interface SearchResult extends SearchEntry {
  score: number;
}

export function searchIndex(query: string, isAdmin = false): SearchResult[] {
  const q = query.toLowerCase().trim();
  if (!q || q.length < 1) return [];

  const results = SEARCH_INDEX
    .filter(entry => isAdmin || !entry.adminOnly)
    .map(entry => {
      let score = 0;
      const titleLower = entry.title.toLowerCase();
      const descLower = entry.description.toLowerCase();

      if (titleLower === q) score += 100;
      else if (titleLower.startsWith(q)) score += 80;
      else if (titleLower.includes(q)) score += 60;

      if (descLower.includes(q)) score += 20;

      const kwMatch = entry.keywords.some(k => {
        const kl = k.toLowerCase();
        return kl === q || kl.includes(q) || q.includes(kl);
      });
      if (kwMatch) score += 40;

      if (entry.category.toLowerCase().includes(q)) score += 10;

      return { ...entry, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return results;
}
