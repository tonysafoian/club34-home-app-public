import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { LayoutGrid, Users, Search, Home, Zap } from 'lucide-react';

const NAV_ITEMS = [
  { label: 'Home', icon: Home, path: '/' },
  { label: 'Prod', icon: LayoutGrid, path: '/productivity' },
  { label: 'Systems', icon: Home, path: '/home-systems' },
  { label: 'Family', icon: Users, path: '/family' },
  { label: 'Auto', icon: Zap, path: '/automations' },
  { label: 'Search', icon: Search, path: '/search' },
];

export function MobileBottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border/40 bg-background/95 backdrop-blur-xl md:hidden pb-[env(safe-area-inset-bottom,0px)]">
      <div className="flex items-center justify-around px-1 py-1">
        {NAV_ITEMS.map(({ label, icon: Icon, path }) => {
          const isActive = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={cn(
                'flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-lg text-[9px] font-medium transition-all duration-150 active:scale-90 min-w-0 flex-1',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
              )}
            >
              <Icon className={cn('h-5 w-5 transition-transform duration-150', isActive && 'drop-shadow-sm scale-110')} />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
