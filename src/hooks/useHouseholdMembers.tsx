import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/apiClient";
import { toast } from "@/hooks/use-toast";

export interface HouseholdMember {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
  isActive: boolean;
  supabaseUuid?: string | null;
  notionUuid?: string | null;
  whatsappNumber?: string | null;
  aliases?: string[] | null;
  createdAt?: string;
  updatedAt?: string;
}

export function useHouseholdMembers() {
  return useQuery<HouseholdMember[]>({
    queryKey: ['/api/data/household-members'],
    queryFn: async () => {
      const data = await apiClient.get<HouseholdMember[]>('/api/data/household-members');
      return Array.isArray(data) ? data : [];
    },
    staleTime: 60_000,
  });
}

export function useCreateHouseholdMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (member: { displayName: string; email?: string | null; role?: string; whatsappNumber?: string | null; aliases?: string[] | null }) => {
      return apiClient.post<HouseholdMember>('/api/data/household-members', member);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/data/household-members'] });
      toast({ title: "Member added", description: "Household member created successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to add member", description: err.message, variant: "destructive" });
    },
  });
}

export function useUpdateHouseholdMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Partial<HouseholdMember> }) => {
      return apiClient.patch<HouseholdMember>(`/api/data/household-members/${id}`, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/data/household-members'] });
      toast({ title: "Member updated", description: "Household member saved." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to update member", description: err.message, variant: "destructive" });
    },
  });
}

export function useDeleteHouseholdMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return apiClient.del(`/api/data/household-members/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/data/household-members'] });
      toast({ title: "Member removed", description: "Household member deleted." });
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete member", description: err.message, variant: "destructive" });
    },
  });
}
