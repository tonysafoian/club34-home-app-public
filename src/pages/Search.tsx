import { useState, useEffect, useRef } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Search as SearchIcon, ChevronRight,
  LayoutDashboard, Shield, Camera, Car, Home, Users, Zap, Activity, Cloud,
  Settings, CheckSquare, Terminal, Calendar, Sun, TrendingUp, Thermometer,
  UserSearch, CalendarDays, DoorOpen, UserX, Battery, MapPin, BatteryLow,
  Waves, Droplets, Warehouse, Monitor, Plane, Music, Clapperboard,
  Mail, HeartPulse, ScanSearch, ScrollText, Globe, FileText, Database,
  RefreshCw, Webhook, KeyRound, BrainCircuit, Lightbulb, Settings2,
  House, ShoppingBag, ShoppingCart, PanelLeft, Layers, ToggleLeft,
  Brain, Bell, MessageCircle, Download, Mic, type LucideIcon,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { searchIndex, SearchResult } from '@/lib/searchIndex';
import { useUserRole } from '@/hooks/useUserRole';

// Map icon name string → Lucide component
const ICON_MAP: Record<string, LucideIcon> = {
  LayoutDashboard, Shield, Camera, Car, Home, Users, Zap, Activity, Cloud,
  Settings, CheckSquare, Terminal, Calendar, Sun, TrendingUp, Thermometer,
  UserSearch, CalendarDays, DoorOpen, UserX, Battery, MapPin, BatteryLow,
  Waves, Droplets, Warehouse, Monitor, Plane, Music, Clapperboard,
  Mail, HeartPulse, ScanSearch, ScrollText, Globe, FileText, Database,
  RefreshCw, Webhook, KeyRound, BrainCircuit, Lightbulb, Settings2,
  House, ShoppingBag, ShoppingCart, PanelLeft, Layers, ToggleLeft,
  Brain, Bell, MessageCircle, Download, Mic, Search: SearchIcon,
};

const CATEGORY_COLORS: Record<string, string> = {
  Page: 'bg-primary/10 text-primary border-primary/20',
  Feature: 'bg-accent/10 text-accent-foreground border-accent/20',
  System: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  Action: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20',
  Admin: 'bg-destructive/10 text-destructive border-destructive/20',
};

function ResultCard({ result, onNavigate }: { result: SearchResult; onNavigate: (path: string, hash?: string) => void }) {
  const IconComponent = ICON_MAP[result.icon] ?? SearchIcon;
  const colorClass = CATEGORY_COLORS[result.category] ?? CATEGORY_COLORS.Feature;

  return (
    <button
      onClick={() => onNavigate(result.path, result.hash)}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-accent/30 transition-colors text-left group border-b border-border/40 last:border-0"
    >
      <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-muted flex items-center justify-center group-hover:bg-primary/10 transition-colors">
        <IconComponent className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-foreground truncate">{result.title}</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 flex-shrink-0 ${colorClass}`}>
            {result.category}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">{result.description}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground/40 flex-shrink-0 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
    </button>
  );
}

const CATEGORY_ORDER = ['Page', 'System', 'Feature', 'Action', 'Admin'];

export default function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') ?? '');
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { isAdmin } = useUserRole();

  // Run search whenever query changes
  useEffect(() => {
    const q = query.trim();
    setResults(q.length > 0 ? searchIndex(q, isAdmin) : []);
    if (q) {
      setSearchParams({ q }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  }, [query, isAdmin, setSearchParams]);

  // Auto-focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const handleNavigate = (path: string, hash?: string) => {
    navigate(hash ? `${path}#${hash}` : path);
  };

  // Group results by category
  const grouped = CATEGORY_ORDER.reduce<Record<string, SearchResult[]>>((acc, cat) => {
    const items = results.filter(r => r.category === cat);
    if (items.length > 0) acc[cat] = items;
    return acc;
  }, {});

  const hasResults = results.length > 0;
  const hasQuery = query.trim().length > 0;

  return (
    <ErrorBoundary name="search">
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border px-4 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-3 py-3">
          <button
            onClick={() => navigate(-1)}
            className="flex-shrink-0 h-9 w-9 rounded-full flex items-center justify-center hover:bg-accent transition-colors"
          >
            <ArrowLeft className="h-5 w-5 text-foreground" />
          </button>

          <div className="flex-1 relative">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search Janus…"
              className="pl-9 h-10 rounded-full border-border/60 bg-muted/40 focus-visible:ring-primary/40"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full bg-muted-foreground/20 flex items-center justify-center hover:bg-muted-foreground/30 transition-colors"
              >
                <span className="text-[10px] text-muted-foreground font-bold leading-none">✕</span>
              </button>
            )}
          </div>
        </div>

        {/* Query label */}
        {hasQuery && (
          <p className="text-xs text-muted-foreground pb-2 pl-1">
            {hasResults
              ? <><span className="font-medium text-foreground">{results.length} result{results.length !== 1 ? 's' : ''}</span> for "<span className="text-primary">{query.trim()}</span>"</>
              : <>No results for "<span className="text-foreground">{query.trim()}</span>"</>
            }
          </p>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!hasQuery && (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <SearchIcon className="h-8 w-8 text-muted-foreground/60" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground mb-1">Search Janus</h2>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[280px]">
                Find any page, system, feature, or action instantly. Try "pool", "tesla", or "cameras".
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {['Pool', 'Tesla', 'Cameras', 'Weather', 'Lights', 'Garage'].map(hint => (
                <button
                  key={hint}
                  onClick={() => setQuery(hint)}
                  className="text-xs px-3 py-1.5 rounded-full border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {hasQuery && !hasResults && (
          <div className="flex flex-col items-center justify-center gap-4 py-24 text-center px-8">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
              <SearchIcon className="h-8 w-8 text-muted-foreground/40" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground mb-1">No results found</h2>
              <p className="text-sm text-muted-foreground max-w-[280px] leading-relaxed">
                Nothing matched "<span className="font-medium">{query.trim()}</span>". Try a different term, or ask Janus directly.
              </p>
            </div>
          </div>
        )}

        {hasResults && Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <div className="px-4 py-2 bg-muted/30">
              <span className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
                {category}
              </span>
            </div>
            <div className="bg-background">
              {items.map(result => (
                <ResultCard key={result.id} result={result} onNavigate={handleNavigate} />
              ))}
            </div>
          </div>
        ))}

        {/* Bottom padding for mobile nav */}
        <div className="h-24" />
      </div>
    </div>
    </ErrorBoundary>
  );
}
