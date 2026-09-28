import { useState } from 'react';
import { format, addDays, startOfWeek, isSameDay } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WeekStripProps {
  selected: Date;
  onSelect: (date: Date) => void;
}

export function WeekStrip({ selected, onSelect }: WeekStripProps) {
  const [weekStart, setWeekStart] = useState(() =>
    startOfWeek(new Date(), { weekStartsOn: 1 })
  );

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={() => setWeekStart((prev) => addDays(prev, -7))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-1 gap-1 justify-center">
        {days.map((day) => {
          const isSelected = isSameDay(day, selected);
          const isToday = isSameDay(day, today);

          return (
            <button
              key={day.toISOString()}
              onClick={() => onSelect(day)}
              className={cn(
                'flex flex-col items-center rounded-lg px-2 py-1.5 text-xs transition-colors min-w-[2.5rem]',
                isSelected
                  ? 'bg-primary text-primary-foreground'
                  : isToday
                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              )}
            >
              <span className="font-medium leading-tight">
                {format(day, 'EEE')}
              </span>
              <span className={cn('text-[0.7rem] leading-tight mt-0.5', isSelected ? 'font-semibold' : '')}>
                {format(day, 'd')}
              </span>
            </button>
          );
        })}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        onClick={() => setWeekStart((prev) => addDays(prev, 7))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
