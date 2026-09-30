import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Mail, MessageSquare, FileText, Calendar, MapPin, Home, Car, Shield, Search,
  Bell, ShoppingCart, Plane, Brain, Sparkles, Film, Globe, Wrench, Zap, ChevronDown, ChevronUp,
} from 'lucide-react';

interface SkillParam {
  name: string;
  type: string;
  required?: boolean;
  description: string;
}

interface Skill {
  name: string;
  description: string;
  adminOnly?: boolean;
  channels: ('chat' | 'email' | 'whatsapp')[];
  params?: SkillParam[];
}

interface SkillCategory {
  category: string;
  icon: typeof Mail;
  color: string;
  skills: Skill[];
}

const SKILL_CATEGORIES: SkillCategory[] = [
  {
    category: 'Communication',
    icon: Mail,
    color: 'blue',
    skills: [
      { name: 'send_email', description: 'Send an email from assistant@example.com for longer or formal communications.', adminOnly: true, channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'to', type: 'string', required: true, description: 'Recipient email address' }, { name: 'subject', type: 'string', required: true, description: 'Email subject line' }, { name: 'body', type: 'string', required: true, description: 'Email body (HTML supported)' }] },
      { name: 'gmail_search', description: "Search primary Gmail inbox using Gmail search syntax (from:, is:unread, etc.).", adminOnly: true, channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'query', type: 'string', required: true, description: 'Gmail search query' }, { name: 'max_results', type: 'number', required: false, description: 'Max results (default 10, max 20)' }] },
      { name: 'send_whatsapp', description: 'Send a WhatsApp message via WATI. Works even if the recipient has not recently messaged Janus.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'to', type: 'string', required: true, description: 'Phone number (international format)' }, { name: 'message', type: 'string', required: true, description: 'Message text' }] },
    ],
  },
  {
    category: 'Notion Management',
    icon: FileText,
    color: 'gray',
    skills: [
      { name: 'query_notion_database', description: 'Query a Notion database to find pages and tasks matching specific filters.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'database_id', type: 'string', required: true, description: 'Notion database ID' }, { name: 'filter', type: 'object', required: false, description: 'Notion filter object' }] },
      { name: 'update_notion_page', description: 'Update properties on an existing Notion page (status, due dates, assignees, etc.).', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'page_id', type: 'string', required: true, description: 'Notion page ID' }, { name: 'properties', type: 'object', required: true, description: 'Properties to update' }] },
      { name: 'create_notion_page', description: 'Create a new page in a Notion database with specified properties.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'database_id', type: 'string', required: true, description: 'Target database ID' }, { name: 'properties', type: 'object', required: true, description: 'Page properties' }] },
      { name: 'batch_update_notion_pages', description: 'Update the same properties on multiple Notion pages simultaneously.', adminOnly: true, channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'page_ids', type: 'string[]', required: true, description: 'Array of page IDs' }, { name: 'properties', type: 'object', required: true, description: 'Properties to apply' }] },
      { name: 'get_notion_database', description: 'Retrieve a Notion database schema showing property names and types.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'database_id', type: 'string', required: true, description: 'Database ID to inspect' }] },
      { name: 'attach_file_to_notion', description: 'Upload and attach a file or image to a Notion page body.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'page_id', type: 'string', required: true, description: 'Notion page ID' }, { name: 'base64_data', type: 'string', required: true, description: 'Base64-encoded file' }, { name: 'filename', type: 'string', required: true, description: 'Filename with extension' }, { name: 'mime_type', type: 'string', required: true, description: 'MIME type' }] },
    ],
  },
  {
    category: 'Calendar & Maps',
    icon: Calendar,
    color: 'green',
    skills: [
      { name: 'get_calendar_events', description: 'Get Google Calendar events for a specific calendar and time range.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'calendar_id', type: 'string', required: true, description: 'Calendar ID or email' }, { name: 'time_min', type: 'string', required: true, description: 'Start time (ISO 8601)' }, { name: 'time_max', type: 'string', required: true, description: 'End time (ISO 8601)' }, { name: 'max_results', type: 'number', required: false, description: 'Maximum events to return' }] },
      { name: 'create_calendar_event', description: "Create a Google Calendar event with conflict detection on Primary calendar.", channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'calendar_id', type: 'string', required: true, description: 'Calendar ID' }, { name: 'title', type: 'string', required: true, description: 'Event title' }, { name: 'start', type: 'string', required: true, description: 'Start time (ISO 8601)' }, { name: 'end', type: 'string', required: true, description: 'End time (ISO 8601)' }, { name: 'attendees', type: 'string[]', required: false, description: 'Attendee emails' }] },
      { name: 'delete_calendar_event', description: 'Delete a Google Calendar event by event ID.', adminOnly: true, channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'calendar_id', type: 'string', required: true, description: 'Calendar ID' }, { name: 'event_id', type: 'string', required: true, description: 'Event ID' }] },
      { name: 'check_availability', description: 'Check free/busy availability for one or more people across calendars.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'emails', type: 'string[]', required: true, description: 'Email addresses to check' }, { name: 'time_min', type: 'string', required: true, description: 'Start of window' }, { name: 'time_max', type: 'string', required: true, description: 'End of window' }] },
      { name: 'get_directions', description: 'Get driving directions and travel time via Google Maps. Defaults to home as origin.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'destination', type: 'string', required: true, description: 'Destination address' }, { name: 'origin', type: 'string', required: false, description: 'Origin (default: Home)' }, { name: 'mode', type: 'string', required: false, description: 'Travel mode (driving, walking, transit)' }] },
      { name: 'search_places', description: 'Search for places and businesses near a given location.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'query', type: 'string', required: true, description: 'Search query' }, { name: 'near', type: 'string', required: false, description: 'Location context' }] },
    ],
  },
  {
    category: 'Home Automation',
    icon: Home,
    color: 'orange',
    skills: [
      { name: 'ha_get_states', description: 'Get current state of all Home Assistant entities in a domain (lights, climate, sensors, etc.).', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'domain', type: 'string', required: false, description: 'Filter by domain (light, climate, etc.)' }] },
      { name: 'ha_get_state', description: 'Get the current state of a specific Home Assistant entity.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'entity_id', type: 'string', required: true, description: 'Entity ID (e.g., light.living_room)' }] },
      { name: 'ha_call_service', description: 'Control a Home Assistant device: turn on/off lights, set temperature, open/close covers, trigger scenes and automations.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'domain', type: 'string', required: true, description: 'Domain (light, switch, climate, cover, scene)' }, { name: 'service', type: 'string', required: true, description: 'Service (turn_on, turn_off, toggle, set_temperature)' }, { name: 'service_data', type: 'object', required: false, description: 'Service data including entity_id' }] },
      { name: 'ha_get_logbook', description: 'Get Home Assistant activity log showing recent events in the house.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'hours', type: 'number', required: false, description: 'How many hours back to look' }, { name: 'entity_id', type: 'string', required: false, description: 'Filter to specific entity' }] },
    ],
  },
  {
    category: 'Vehicles & Security',
    icon: Car,
    color: 'red',
    skills: [
      { name: 'check_tesla_status', description: 'Check battery level, range, charging state, lock status, temperature, and location for all connected Tesla vehicles.', channels: ['chat', 'email', 'whatsapp'], params: [] },
      { name: 'check_verkada_security', description: 'Check Verkada security system: camera online/offline counts, recent person-of-interest sightings, and access events.', channels: ['chat', 'email', 'whatsapp'], params: [] },
      { name: 'check_generator_status', description: 'Check Generac generator status including battery level, run hours, and operational state.', channels: ['chat', 'email', 'whatsapp'], params: [] },
    ],
  },
  {
    category: 'Research & Knowledge',
    icon: Brain,
    color: 'purple',
    skills: [
      { name: 'web_search', description: 'Search the web for information, links, products, or news.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'query', type: 'string', required: true, description: 'Search query' }, { name: 'limit', type: 'number', required: false, description: 'Max results' }] },
      { name: 'search_news', description: 'Search for recent news articles with time period filtering.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'query', type: 'string', required: true, description: 'News search query' }, { name: 'period', type: 'string', required: false, description: 'Time period (hour, day, week, month)' }] },
      { name: 'scrape_website', description: 'Scrape a webpage and extract its content as clean markdown text.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'url', type: 'string', required: true, description: 'URL to scrape' }] },
      { name: 'browse_website', description: 'Open a full headless Chrome browser (via Browserbase) to interact with websites — click buttons, fill forms, scroll, navigate JS-heavy pages, and extract data. Much more powerful than scrape_website but slower (~30-60s).', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'url', type: 'string', required: true, description: 'URL to browse' }, { name: 'instruction', type: 'string', required: true, description: 'Natural language instruction for what to do on the page' }, { name: 'steps', type: 'array', required: false, description: 'Optional ordered steps: navigate/act/extract with values' }] },
      { name: 'launch_research', description: 'Launch a deep research task using Claude AI. Performs 6-8 web searches, synthesizes findings, and emails a comprehensive report in ~10 minutes.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'topic', type: 'string', required: true, description: 'Research topic' }, { name: 'instructions', type: 'string', required: false, description: 'Specific instructions for depth/angle' }, { name: 'email_to', type: 'string', required: true, description: 'Email for the report' }] },
      { name: 'get_environment_data', description: 'Get air quality, pollen levels, and weather alerts for the home area.', channels: ['chat', 'email', 'whatsapp'], params: [] },
    ],
  },
  {
    category: 'Memory & Reminders',
    icon: Bell,
    color: 'yellow',
    skills: [
      { name: 'remember_fact', description: "Save a permanent fact to Janus's long-term memory for future recall across all channels.", channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'key', type: 'string', required: true, description: 'Fact key/label' }, { name: 'value', type: 'string', required: true, description: 'Fact value' }, { name: 'context', type: 'string', required: false, description: 'Additional context' }] },
      { name: 'recall_facts', description: 'Search and retrieve stored facts from long-term memory.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'key_search', type: 'string', required: true, description: 'Search term for fact keys' }] },
      { name: 'set_reminder', description: 'Schedule a future reminder notification via email or WhatsApp at a specific date/time. Includes deduplication to prevent duplicate reminders.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'due_at', type: 'string', required: true, description: 'When to send (ISO 8601)' }, { name: 'message', type: 'string', required: true, description: 'Reminder message text' }, { name: 'channel', type: 'string', required: true, description: 'Delivery channel (email or whatsapp)' }] },
    ],
  },
  {
    category: 'Google Workspace',
    icon: Sparkles,
    color: 'cyan',
    skills: [
      { name: 'create_google_file', description: 'Create a Google Workspace file (Doc, Sheet, Slides, or Form) in Drive and share with the user. Slides get professional formatting with themed colors, fonts, and layouts.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'file_type', type: 'string', required: true, description: 'Type: doc, sheet, slides, or form' }, { name: 'title', type: 'string', required: true, description: 'File title' }, { name: 'content', type: 'string', required: true, description: 'Content (markdown for docs, | rows for sheets, --- separated for slides)' }, { name: 'share_with', type: 'string[]', required: false, description: 'Additional emails to share with' }] },
    ],
  },
  {
    category: 'Media & Entertainment',
    icon: Film,
    color: 'pink',
    skills: [
      { name: 'generate_media', description: 'Generate AI images (Gemini or FAL FLUX Pro) or videos (Veo 3.1). Household members only.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'prompt', type: 'string', required: true, description: 'Image/video prompt' }, { name: 'type', type: 'string', required: true, description: 'image or video' }, { name: 'platform', type: 'string', required: false, description: 'gemini (fast) or fal (higher quality)' }] },
      { name: 'query_entertainment', description: 'Query upcoming entertainment events: Lakers games, F1 races, concerts, and shows.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'category', type: 'string', required: false, description: 'Filter: lakers, f1, concert, shows, broadway' }, { name: 'upcoming_only', type: 'boolean', required: false, description: 'Only future events (default true)' }] },
      { name: 'query_media', description: 'Query movies and TV shows: theater releases, streaming picks, and kids content.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'category', type: 'string', required: false, description: 'Filter: theater, streaming, kids' }, { name: 'limit', type: 'number', required: false, description: 'Max results (default 10)' }] },
      { name: 'suggest_movie', description: 'Get AI-powered movie recommendations based on mood, genre, or description.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'query', type: 'string', required: true, description: 'Mood or genre description' }] },
    ],
  },
  {
    category: 'Shopping & Travel',
    icon: ShoppingCart,
    color: 'emerald',
    skills: [
      { name: 'save_to_cart', description: 'Add a product to the cross-platform shopping cart (Amazon, Instacart, etc.).', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'platform', type: 'string', required: true, description: 'Shopping platform' }, { name: 'product_name', type: 'string', required: true, description: 'Product name' }] },
      { name: 'view_cart', description: 'View all items currently in the shopping cart.', channels: ['chat', 'email', 'whatsapp'], params: [] },
      { name: 'clear_cart', description: 'Clear all items from the shopping cart.', channels: ['chat', 'email', 'whatsapp'], params: [] },
      { name: 'manage_trip', description: 'Create, update, or delete trip cards with flight/hotel details in the Family Travel section.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'action', type: 'string', required: true, description: 'create, update, or delete' }, { name: 'trip_name', type: 'string', required: true, description: 'Trip name' }, { name: 'destination', type: 'string', required: false, description: 'Destination city/country' }, { name: 'flights', type: 'array', required: false, description: 'Flight details' }, { name: 'hotels', type: 'array', required: false, description: 'Hotel details' }] },
      { name: 'query_trips', description: 'Query upcoming or past family trips.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'status', type: 'string', required: false, description: 'Trip status filter' }, { name: 'upcoming_only', type: 'boolean', required: false, description: 'Only future trips' }] },
    ],
  },
  {
    category: 'System & Admin',
    icon: Wrench,
    color: 'slate',
    skills: [
      { name: 'query_activity_log', description: 'Query household activity events: motion, alarms, system events.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'event_type', type: 'string', required: false, description: 'Filter by event type' }, { name: 'hours', type: 'number', required: false, description: 'Hours to look back (default 24)' }] },
      { name: 'query_system_health', description: 'Check app health, audit logs, and system status.', adminOnly: true, channels: ['chat', 'email', 'whatsapp'], params: [] },
      { name: 'query_system_updates', description: 'Get the app changelog and recent feature updates.', channels: ['chat', 'email', 'whatsapp'], params: [{ name: 'limit', type: 'number', required: false, description: 'Number of updates to return' }] },
    ],
  },
];

const COLOR_MAP: Record<string, string> = {
  blue: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  gray: 'bg-gray-500/10 text-gray-600 border-gray-500/20',
  green: 'bg-green-500/10 text-green-600 border-green-500/20',
  orange: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  red: 'bg-red-500/10 text-red-600 border-red-500/20',
  purple: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  yellow: 'bg-yellow-500/10 text-yellow-700 border-yellow-500/20',
  cyan: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
  pink: 'bg-pink-500/10 text-pink-600 border-pink-500/20',
  emerald: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
  slate: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
};

const ICON_BG_MAP: Record<string, string> = {
  blue: 'bg-blue-500/10 text-blue-500',
  gray: 'bg-gray-500/10 text-gray-500',
  green: 'bg-green-500/10 text-green-500',
  orange: 'bg-orange-500/10 text-orange-500',
  red: 'bg-red-500/10 text-red-500',
  purple: 'bg-purple-500/10 text-purple-500',
  yellow: 'bg-yellow-500/10 text-yellow-600',
  cyan: 'bg-cyan-500/10 text-cyan-500',
  pink: 'bg-pink-500/10 text-pink-500',
  emerald: 'bg-emerald-500/10 text-emerald-500',
  slate: 'bg-slate-500/10 text-slate-500',
};

function ChannelBadge({ channel }: { channel: string }) {
  const styles: Record<string, string> = {
    chat: 'bg-blue-500/10 text-blue-600',
    email: 'bg-amber-500/10 text-amber-600',
    whatsapp: 'bg-green-500/10 text-green-600',
  };
  return <Badge className={`${styles[channel] || ''} text-[10px] px-1.5 py-0`} data-testid={`badge-channel-${channel}`}>{channel}</Badge>;
}

function SkillCard({ skill, color }: { skill: Skill; color: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasParams = skill.params && skill.params.length > 0;

  return (
    <div
      className={`border rounded-lg p-3 transition-colors hover:bg-muted/30 ${COLOR_MAP[color]?.split(' ').filter(c => c.startsWith('border')).join(' ') || 'border-border'}`}
      data-testid={`skill-card-${skill.name}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-mono font-semibold" data-testid={`skill-name-${skill.name}`}>{skill.name}</code>
            {skill.adminOnly && <Badge variant="destructive" className="text-[10px] px-1.5 py-0">Admin Only</Badge>}
          </div>
          <p className="text-sm text-muted-foreground mt-1" data-testid={`skill-desc-${skill.name}`}>{skill.description}</p>
          <div className="flex items-center gap-1.5 mt-2">
            {skill.channels.map(ch => <ChannelBadge key={ch} channel={ch} />)}
          </div>
        </div>
        {hasParams && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground p-1 shrink-0"
            data-testid={`toggle-params-${skill.name}`}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        )}
      </div>
      {expanded && hasParams && (
        <div className="mt-3 pt-3 border-t border-border/50 space-y-1.5" data-testid={`params-${skill.name}`}>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Parameters</p>
          {skill.params!.map(p => (
            <div key={p.name} className="flex items-start gap-2 text-xs">
              <code className="font-mono text-foreground shrink-0">{p.name}</code>
              <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">{p.type}</Badge>
              {p.required && <Badge className="bg-amber-500/10 text-amber-600 text-[10px] px-1 py-0 shrink-0">required</Badge>}
              <span className="text-muted-foreground">{p.description}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminJanusSkillsContent() {
  const [search, setSearch] = useState('');
  const lowerSearch = search.toLowerCase();

  const totalSkills = SKILL_CATEGORIES.reduce((sum, cat) => sum + cat.skills.length, 0);
  const adminOnlyCount = SKILL_CATEGORIES.reduce((sum, cat) => sum + cat.skills.filter(s => s.adminOnly).length, 0);

  const filtered = SKILL_CATEGORIES.map(cat => ({
    ...cat,
    skills: cat.skills.filter(s =>
      !search ||
      s.name.toLowerCase().includes(lowerSearch) ||
      s.description.toLowerCase().includes(lowerSearch) ||
      cat.category.toLowerCase().includes(lowerSearch)
    ),
  })).filter(cat => cat.skills.length > 0);

  return (
    <div className="space-y-6" data-testid="admin-janus-skills">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Janus Skills
          </CardTitle>
          <CardDescription>
            {totalSkills} tools across {SKILL_CATEGORIES.length} categories. {adminOnlyCount} are admin-only.
            Each skill is available on Chat, Email, and WhatsApp channels.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="relative" data-testid="search-skills">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search skills..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
              data-testid="input-search-skills"
            />
          </div>
        </CardContent>
      </Card>

      {filtered.map(cat => {
        const Icon = cat.icon;
        return (
          <Card key={cat.category} data-testid={`category-${cat.category.toLowerCase().replace(/\s+/g, '-')}`}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2.5 text-base">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${ICON_BG_MAP[cat.color] || ''}`}>
                  <Icon className="h-4 w-4" />
                </div>
                {cat.category}
                <Badge variant="secondary" className="ml-auto text-xs">{cat.skills.length} skill{cat.skills.length !== 1 ? 's' : ''}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {cat.skills.map(skill => (
                <SkillCard key={skill.name} skill={skill} color={cat.color} />
              ))}
            </CardContent>
          </Card>
        );
      })}

      {filtered.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No skills match "{search}"
          </CardContent>
        </Card>
      )}
    </div>
  );
}
