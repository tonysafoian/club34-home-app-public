import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useUserProfile } from '@/hooks/useUserProfile';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function DashboardGreeting() {
  const { user } = useAuth();
  const { displayName: profileName } = useUserProfile();

  const metaName = useMemo(() => {
    if (!user) return null;
    const name = user.displayName;
    if (name && !name.includes('@')) return name.split(' ')[0];
    return null;
  }, [user]);

  const firstName = profileName?.split(' ')[0] ?? metaName;
  const greeting = getGreeting();

  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">
        {greeting}{firstName ? `, ${firstName}` : ''}
      </h1>
    </div>
  );
}
