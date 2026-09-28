import { format } from 'date-fns';
import { CalendarIcon, Filter, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ActivityEventType } from '@/types/activity';

interface ActivityFiltersProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
  selectedType: ActivityEventType | 'all';
  onTypeChange: (type: ActivityEventType | 'all') => void;
  selectedZone: string | 'all';
  onZoneChange: (zone: string | 'all') => void;
  availableZones: string[];
}

const eventTypes: { value: ActivityEventType | 'all'; label: string }[] = [
  { value: 'all', label: 'All Types' },
  { value: 'motion', label: 'Motion' },
  { value: 'access', label: 'Access' },
  { value: 'alarm', label: 'Alarm' },
  { value: 'camera', label: 'Camera' },
  { value: 'system', label: 'System' },
];

export function ActivityFilters({
  selectedDate,
  onDateChange,
  selectedType,
  onTypeChange,
  selectedZone,
  onZoneChange,
  availableZones,
}: ActivityFiltersProps) {
  const hasFilters = selectedType !== 'all' || selectedZone !== 'all';

  const clearFilters = () => {
    onTypeChange('all');
    onZoneChange('all');
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Date Picker */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className="gap-2 min-w-[180px] justify-start">
            <CalendarIcon className="h-4 w-4" />
            {format(selectedDate, 'PPP')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => date && onDateChange(date)}
            initialFocus
            className={cn("p-3 pointer-events-auto")}
          />
        </PopoverContent>
      </Popover>

      {/* Event Type Filter */}
      <Select value={selectedType} onValueChange={(v) => onTypeChange(v as ActivityEventType | 'all')}>
        <SelectTrigger className="w-[140px]">
          <Filter className="h-4 w-4 mr-2" />
          <SelectValue placeholder="Event Type" />
        </SelectTrigger>
        <SelectContent>
          {eventTypes.map((type) => (
            <SelectItem key={type.value} value={type.value}>
              {type.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Zone Filter */}
      <Select value={selectedZone} onValueChange={onZoneChange}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="All Zones" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Zones</SelectItem>
          {availableZones.map((zone) => (
            <SelectItem key={zone} value={zone}>
              {zone}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Active Filters */}
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1 text-muted-foreground">
          <X className="h-3 w-3" />
          Clear filters
        </Button>
      )}
    </div>
  );
}
