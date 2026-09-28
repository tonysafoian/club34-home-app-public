import { useUserProfile } from './useUserProfile';

type AppRole = 'admin' | 'member' | 'guest';

interface UserRoleState {
  role: AppRole | null;
  isAdmin: boolean;
  loading: boolean;
}

export function useUserRole(): UserRoleState {
  const { role, isAdmin, loading } = useUserProfile();
  return { role, isAdmin, loading };
}
