import { cn } from '@/lib/utils';
import club34Icon from '@/assets/club34-logo.png';

interface Club34LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'full' | 'icon' | 'emoji';
  className?: string;
}

const sizeClasses = {
  sm: { container: 'w-10 h-10', text: 'text-xs' },
  md: { container: 'w-[4.2rem] h-[4.2rem]', text: 'text-sm' },
  lg: { container: 'w-[4.2rem] h-[4.2rem]', text: 'text-base' },
  xl: { container: 'w-24 h-24', text: 'text-lg' },
};

export function Club34Logo({ size = 'md', variant = 'full', className }: Club34LogoProps) {
  const sizes = sizeClasses[size];

  if (variant === 'emoji') {
    return (
      <span 
        className={cn(
          'inline-flex items-center justify-center w-6 h-6 rounded-full club34-gradient text-xs font-display font-bold text-primary-foreground shadow-md',
          className
        )}
      >
        34
      </span>
    );
  }

  const IconLogo = (
    <img
      src={club34Icon}
      alt="Club 34"
      className={cn(sizes.container, 'object-cover rounded-full', className)}
    />
  );

  if (variant === 'icon') {
    return IconLogo;
  }

  return (
    <div className={cn('flex items-center gap-3', className)}>
      {IconLogo}
    </div>
  );
}

export function Club34Emoji({ className }: { className?: string }) {
  return (
    <span 
      className={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded-full club34-gradient text-xs font-display font-bold text-primary-foreground shadow-md',
        className
      )}
    >
      34
    </span>
  );
}
