import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SectionItem {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

export interface SectionGroup {
  group: string;
  items: SectionItem[];
}

interface SectionNavProps {
  groups: SectionGroup[];
  activeSection: string;
  onSectionChange: (id: string) => void;
}

export function MobileChipNav({ groups, activeSection, onSectionChange }: SectionNavProps) {
  const allItems = groups.flatMap(g => g.items);

  return (
    <div className="sticky z-30 border-b border-border/40 bg-background/95 backdrop-blur-sm" style={{ top: 'calc(2.75rem + env(safe-area-inset-top, 0px))' }}>
      <div className="flex overflow-x-auto scrollbar-hide px-3 py-1.5 gap-1.5">
        {allItems.map(({ id, label, icon: Icon, badge }) => (
          <button
            key={id}
            onClick={() => onSectionChange(id)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0',
              activeSection === id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
            {badge && badge > 0 ? (
              <span className={cn(
                'ml-0.5 inline-flex items-center justify-center rounded-full px-1 py-0.5 text-[9px] font-bold leading-none min-w-[0.9rem]',
                activeSection === id
                  ? 'bg-white/20 text-white'
                  : 'bg-warning/15 text-warning'
              )}>
                {badge > 99 ? '99+' : badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DesktopSidebar({ groups, activeSection, onSectionChange }: SectionNavProps) {
  return (
    <aside className="sticky top-14 h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r border-border/40 bg-background">
      <ScrollArea className="h-full py-3 px-2">
        <div className="flex flex-col gap-1">
          {groups.map(({ group, items }) => {
            const groupHasActive = items.some(i => i.id === activeSection);
            return (
              <Collapsible key={group} defaultOpen={groupHasActive}>
                <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors">
                  {group}
                  <ChevronDown className="h-3.5 w-3.5 transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="flex flex-col gap-0.5 pb-2">
                    {items.map(({ id, label, icon: Icon, badge }) => (
                      <button
                        key={id}
                        onClick={() => onSectionChange(id)}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors w-full text-left',
                          activeSection === id
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {label}
                        {badge && badge > 0 ? (
                          <span className={cn(
                            'ml-auto inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold leading-none min-w-[1.25rem]',
                            activeSection === id
                              ? 'bg-white/20 text-white'
                              : 'bg-warning/15 text-warning'
                          )}>
                            {badge > 99 ? '99+' : badge}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
