import { useUserProfile } from './useUserProfile';

type ApprovalStatus = 'pending' | 'approved' | 'rejected';

interface ApprovalState {
  status: ApprovalStatus | null;
  isApproved: boolean;
  isPending: boolean;
  isRejected: boolean;
  loading: boolean;
}

export function useApprovalStatus(): ApprovalState {
  const { approvalStatus, isApproved, isPending, isRejected, loading } = useUserProfile();
  return {
    status: approvalStatus,
    isApproved,
    isPending,
    isRejected,
    loading,
  };
}
