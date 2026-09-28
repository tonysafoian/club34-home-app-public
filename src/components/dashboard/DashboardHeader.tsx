import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { useUserRole } from '@/hooks/useUserRole';
import { useTheme } from '@/hooks/useTheme';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Moon, Sun, Monitor, LogOut, Settings, Download, ShieldCheck, Lightbulb, Search, Sparkles } from 'lucide-react';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { JanusLogo } from '@/components/brand/JanusLogo';
import claudeIcon from '@/assets/claude-icon.png';
import { SuggestionDialog } from '@/components/suggestions/SuggestionDialog';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

export function DashboardHeader() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { isAdmin } = useUserRole();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { canInstall, isInstalled, isIOS, install } = usePWAInstall();
  const [suggestionOpen, setSuggestionOpen] = useState(false);

  // Latest published app version (for the header badge → /updates).
  const { data: latestVersion } = useQuery({
    queryKey: ['system-updates-latest-version'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<{ version: string }[]>({
        table: 'system_updates',
        select: 'version',
        filters: [{ column: 'published_at', op: 'lte', value: new Date().toISOString() }],
        order: { column: 'published_at', ascending: false },
        limit: 1,
      });
      return data?.[0]?.version ?? null;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const avatarUrl = user?.avatarUrl as string | undefined;
  const displayName = (user?.displayName || user?.email || '') as string;
  const initials = displayName
    .split(' ')
    .map((n: string) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/90 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
      <div className="container flex h-11 md:h-16 items-center justify-between">
        <div className="flex items-center gap-2">
          <JanusLogo size="md" variant="full" />
          {latestVersion && (
            <button
              onClick={() => navigate('/updates')}
              className="hidden sm:inline-flex items-center rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:border-border transition-colors"
              aria-label={`What's New — version ${latestVersion}`}
              data-testid="badge-app-version"
            >
              {latestVersion}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          {/* Claude AI — always visible */}
          <button
            onClick={() => window.open('https://claude.ai', '_blank', 'noopener,noreferrer')}
            className="w-8 h-8 md:w-9 md:h-9 rounded-xl overflow-hidden bg-black hover:scale-105 transition-transform"
            aria-label="Open Claude AI"
          >
            <img src={claudeIcon} alt="Claude" className="w-full h-full object-cover" />
          </button>

          {/* What's New — hidden on mobile, in user menu instead */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/updates')}
            aria-label="What's New"
            className="hidden md:inline-flex text-primary/60 hover:text-primary"
          >
            <Sparkles className="h-5 w-5" />
          </Button>

          {/* Search — always visible */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/search')}
            aria-label="Search"
            className="h-8 w-8 md:h-9 md:w-9"
          >
            <Search className="h-4 w-4 md:h-5 md:w-5" />
          </Button>

          {/* Suggestions — hidden on mobile, in user menu instead */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSuggestionOpen(true)}
            aria-label="Make a suggestion"
            className="hidden md:inline-flex text-amber-400/60 hover:text-amber-300"
            style={{ filter: 'drop-shadow(0 0 4px rgba(251, 191, 36, 0.4))' }}
          >
            <Lightbulb className="h-5 w-5" />
          </Button>
          <SuggestionDialog open={suggestionOpen} onOpenChange={setSuggestionOpen} />

          {/* Theme Toggle — hidden on mobile (available in user menu) */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="hidden md:inline-flex">
                {resolvedTheme === 'dark' ? (
                  <Moon className="h-5 w-5" />
                ) : (
                  <Sun className="h-5 w-5" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setTheme('light')}>
                <Sun className="mr-2 h-4 w-4" />Light
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('dark')}>
                <Moon className="mr-2 h-4 w-4" />Dark
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('system')}>
                <Monitor className="mr-2 h-4 w-4" />System
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* User Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full p-0 w-8 h-8 md:w-9 md:h-9 overflow-hidden">
                <Avatar className="h-7 w-7 md:h-8 md:w-8">
                  <AvatarImage src={avatarUrl} alt={displayName} referrerPolicy="no-referrer" />
                  <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex items-center gap-2">
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarImage src={avatarUrl} alt={displayName} referrerPolicy="no-referrer" />
                    <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium truncate">{displayName}</span>
                    <span className="text-xs text-muted-foreground truncate">{user?.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {/* Mobile-only: What's New & Suggestions */}
              <DropdownMenuItem onClick={() => navigate('/updates')} className="md:hidden">
                <Sparkles className="mr-2 h-4 w-4 text-primary/60" />What's New
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSuggestionOpen(true)} className="md:hidden">
                <Lightbulb className="mr-2 h-4 w-4 text-amber-400/70" />Suggest a Feature
              </DropdownMenuItem>
              {/* Mobile-only: Theme options */}
              <DropdownMenuItem onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')} className="md:hidden">
                {resolvedTheme === 'dark' ? (
                  <><Sun className="mr-2 h-4 w-4" />Switch to Light</>
                ) : (
                  <><Moon className="mr-2 h-4 w-4" />Switch to Dark</>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/settings')}>
                <Settings className="mr-2 h-4 w-4" />Settings
              </DropdownMenuItem>
              {isAdmin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => navigate('/admin')}>
                    <ShieldCheck className="mr-2 h-4 w-4" />Admin
                  </DropdownMenuItem>
                </>
              )}
              {(canInstall || isIOS) && !isInstalled && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={canInstall ? install : () => navigate('/install')}>
                    <Download className="mr-2 h-4 w-4" />Install App
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
