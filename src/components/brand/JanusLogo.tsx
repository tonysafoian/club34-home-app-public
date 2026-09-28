import { cn } from '@/lib/utils';
import defaultEmblem from '@/assets/household-emblem.svg';
import { useBranding } from '@/hooks/useBranding';

export interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'full' | 'icon' | 'emoji';
  className?: string;
  showText?: boolean;
}

const sizeClasses = {
  sm: { container: 'w-8 h-8', text: 'text-xs' },
  md: { container: 'w-10 h-10', text: 'text-sm font-semibold' },
  lg: { container: 'w-14 h-14', text: 'text-base font-semibold' },
  xl: { container: 'w-20 h-20', text: 'text-lg font-bold' },
};

export function JanusLogo({ size = 'md', variant = 'full', className, showText = true }: LogoProps) {
  const { estateName, customLogo } = useBranding();
  const sizes = sizeClasses[size];

  // Derive initial abbreviation for emoji variant
  const initials = estateName
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'OS';

  if (variant === 'emoji') {
    return (
      <span 
        className={cn(
          'inline-flex items-center justify-center w-7 h-7 rounded-full janus-gradient text-[11px] font-display font-bold text-primary-foreground shadow-sm tracking-tight',
          className
        )}
      >
        {initials}
      </span>
    );
  }

  const logoSrc = customLogo || defaultEmblem;

  const IconLogo = (
    <img
      src={logoSrc}
      alt={estateName}
      className={cn(sizes.container, 'object-contain rounded-xl shrink-0 transition-transform duration-200', className)}
    />
  );

  if (variant === 'icon') {
    return IconLogo;
  }

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {IconLogo}
      {showText && (
        <span className={cn('font-display tracking-tight text-foreground select-none', sizes.text)}>
          {estateName}
        </span>
      )}
    </div>
  );
}

// Aliases for modern naming
export const HouseholdLogo = JanusLogo;

export function JanusEmoji({ className }: { className?: string }) {
  const { estateName } = useBranding();
  const initials = estateName
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || 'OS';

  return (
    <span 
      className={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded-full janus-gradient text-[10px] font-display font-bold text-primary-foreground shadow-sm',
        className
      )}
    >
      {initials}
    </span>
  );
}
