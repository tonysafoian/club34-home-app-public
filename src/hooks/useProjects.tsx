import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';

export interface JanusProject {
  id: string;
  user_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  notion_page_id?: string | null;
  artifact_count?: number;
  is_shared?: boolean;
  owner_name?: string;
}

export interface JanusProjectArtifact {
  id: string;
  project_id: string;
  artifact_type: string;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  sort_order: number;
  created_at: string;
  saved_by_user_id?: string | null;
  saved_by_display_name?: string | null;
}

export function useProjects() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['janus-projects'],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<JanusProject[]>({
        table: 'janus_projects',
        select: 'id, user_id, name, status, created_at, updated_at, notion_page_id',
        filters: [{ column: 'status', op: 'eq', value: 'active' }],
        order: { column: 'updated_at', ascending: false },
        limit: 100,
      });
      const projects = data || [];
      if (projects.length === 0) return projects;

      const ownerIds = [...new Set(projects.map(p => p.user_id))];
      const { data: profiles } = await apiClient.dbQuery<{ user_id: string; display_name: string | null }[]>({
        table: 'profiles',
        select: 'user_id, display_name',
        filters: [{ column: 'user_id', op: 'in', value: ownerIds }],
      });
      const nameMap = new Map(
        (profiles || []).map(p => [p.user_id, p.display_name])
      );

      const { data: artifactRows } = await apiClient.dbQuery<{ project_id: string }[]>({
        table: 'janus_project_artifacts',
        select: 'project_id',
        filters: [{ column: 'project_id', op: 'in', value: projects.map(p => p.id) }],
      });
      const countMap = new Map<string, number>();
      for (const row of artifactRows || []) {
        countMap.set(row.project_id, (countMap.get(row.project_id) || 0) + 1);
      }

      return projects.map(p => ({
        ...p,
        owner_name: nameMap.get(p.user_id) || undefined,
        artifact_count: countMap.get(p.id) || 0,
      }));
    },
  });
}

export function useProject(projectId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['janus-project', projectId],
    enabled: !!user && !!projectId,
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<JanusProject>({
        table: 'janus_projects',
        select: '*',
        filters: [{ column: 'id', op: 'eq', value: projectId! }],
        single: true,
      });
      return data;
    },
  });
}

export function useProjectArtifacts(projectId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['janus-project-artifacts', projectId],
    enabled: !!user && !!projectId,
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<JanusProjectArtifact[]>({
        table: 'janus_project_artifacts',
        select: '*',
        filters: [{ column: 'project_id', op: 'eq', value: projectId! }],
        order: { column: 'sort_order', ascending: true },
        limit: 100,
      });
      return data || [];
    },
  });
}

export function useCreateProject() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (name?: string) => {
      const { data } = await apiClient.dbInsert<JanusProject[]>('janus_projects', {
        user_id: user!.userId,
        name: name || 'New Project',
      });
      return data?.[0] as JanusProject;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['janus-projects'] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: { id: string } & Partial<JanusProject>) => {
      await apiClient.dbUpdate('janus_projects', updates, [
        { column: 'id', op: 'eq', value: id },
      ]);
      return { id };
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['janus-projects'] });
      queryClient.invalidateQueries({ queryKey: ['janus-project', vars.id] });
    },
  });
}

export function useAddArtifact() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (artifact: {
      project_id: string;
      artifact_type: string;
      title: string;
      content: string;
      metadata?: Record<string, unknown>;
      sort_order: number;
      saved_by_user_id?: string;
      saved_by_display_name?: string;
    }) => {
      const { data } = await apiClient.dbInsert<JanusProjectArtifact[]>('janus_project_artifacts', artifact);
      return data?.[0] as JanusProjectArtifact;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['janus-project-artifacts', data.project_id] });
    },
  });
}

export function useDeleteArtifact() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, project_id }: { id: string; project_id: string }) => {
      await apiClient.dbDelete('janus_project_artifacts', [
        { column: 'id', op: 'eq', value: id },
      ]);
      return { project_id };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['janus-project-artifacts', data.project_id] });
    },
  });
}
