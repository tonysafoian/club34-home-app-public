import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from './useAuth';

type AppRole = 'admin' | 'member' | 'guest';
type ApprovalStatus = 'pending' | 'approved' | 'rejected';

interface UserProfile {
  displayName: string | null;
  avatarUrl: string | null;
  approvalStatus: ApprovalStatus | null;
  role: AppRole | null;
  isAdmin: boolean;
  isApproved: boolean;
  isPending: boolean;
  isRejected: boolean;
  loading: boolean;
}

export function useUserProfile(): UserProfile {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['user-profile', user?.userId],
    queryFn: async () => {
      const [profileRes, roleRes] = await Promise.all([
        apiClient.dbQuery<{ display_name: string | null; avatar_url: string | null; approval_status: string | null }>({
          table: 'profiles',
          select: 'display_name, avatar_url, approval_status',
          filters: [{ column: 'user_id', op: 'eq', value: user!.userId }],
          single: true,
        }),
        apiClient.dbQuery<{ role: string }>({
          table: 'user_roles',
          select: 'role',
          filters: [{ column: 'user_id', op: 'eq', value: user!.userId }],
          single: true,
        }),
      ]);

      return {
        displayName: profileRes.data?.display_name ?? null,
        avatarUrl: profileRes.data?.avatar_url ?? null,
        approvalStatus: (profileRes.data?.approval_status as ApprovalStatus) ?? null,
        role: (roleRes.data?.role as AppRole) ?? null,
      };
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });

  return {
    displayName: data?.displayName ?? null,
    avatarUrl: data?.avatarUrl ?? null,
    approvalStatus: data?.approvalStatus ?? null,
    role: data?.role ?? null,
    isAdmin: data?.role === 'admin',
    isApproved: data?.approvalStatus === 'approved',
    isPending: data?.approvalStatus === 'pending',
    isRejected: data?.approvalStatus === 'rejected',
    loading: isLoading,
  };
}
