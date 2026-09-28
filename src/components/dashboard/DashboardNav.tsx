import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Users, Zap, Home, LayoutGrid } from 'lucide-react';
import { WeatherStrip } from './WeatherStrip';
import { LatestUpdateStrip } from './LatestUpdateStrip';

const NAV_ITEMS = [
  { label: 'Home', icon: Home, path: '/' },
  { label: 'Productivity', icon: LayoutGrid, path: '/productivity' },
  { label: 'Systems', icon: Home, path: '/home-systems' },
  { label: 'Family', icon: Users, path: '/family' },
  { label: 'Automations', icon: Zap, path: '/automations' },
];

export function DashboardNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <>
      <WeatherStrip />
      <LatestUpdateStrip />
      {/* Desktop-only top nav — hidden on mobile where bottom tab bar is used */}
      <div className="hidden md:block sticky z-40 w-full border-b border-border/40 bg-background/90 backdrop-blur-xl" style={{ top: 'calc(4rem + env(safe-area-inset-top, 0px))' }}>
        <div className="container">
          <nav className="flex gap-0.5 sm:gap-1 py-1 overflow-x-auto scrollbar-hide">
            {NAV_ITEMS.map(({ label, icon: Icon, path }) => {
              const isActive = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
              return (
                <button
                  key={path}
                  onClick={() => navigate(path)}
                  className={cn(
                    'inline-flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              );
            })}
          </nav>
        </div>
      </div>
    </>
  );
}
