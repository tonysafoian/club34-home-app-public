import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from './useAuth';
import {
  searchNotionDatabases,
  queryNotionDatabase,
  createNotionPage,
  updateNotionPage,
} from '@/lib/api/notion';
import { toast } from '@/hooks/use-toast';

interface NotionRichText {
  plain_text?: string;
}

interface NotionProperty {
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  date?: { start?: string } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  status?: { name?: string } | null;
}

interface NotionProxyResponse {
  success?: boolean;
  error?: string;
  results?: unknown[];
  page?: unknown;
}

export interface NotionDatabaseSummary {
  id: string;
  title?: Array<{ plain_text?: string }>;
}

export interface NotionSyncConfig {
  id: string;
  user_id?: string;
  notion_database_id: string;
  database_name: string | null;
  sync_direction: string;
  last_synced_at?: string | null;
  created_at?: string;
}

export interface NotionWebhookEventRecord {
  id: string;
  event_type: string;
  processed?: boolean | null;
  notion_page_id?: string | null;
  notion_database_id?: string | null;
  created_at: string;
}

export function extractPageTitle(properties: Record<string, NotionProperty>): string {
  if (!properties) return 'Untitled';
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (prop.type === 'title' && (prop.title?.length ?? 0) > 0) {
      return (prop.title ?? []).map((t) => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

export function extractPropertyValue(prop: NotionProperty | undefined | null): string {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return prop.title?.map((t) => t.plain_text).join('') ?? '';
    case 'rich_text':
      return prop.rich_text?.map((t) => t.plain_text).join('') ?? '';
    case 'number':
      return prop.number?.toString() ?? '';
    case 'select':
      return prop.select?.name ?? '';
    case 'multi_select':
      return prop.multi_select?.map((s) => s.name).join(', ') ?? '';
    case 'date':
      return prop.date?.start ?? '';
    case 'checkbox':
      return prop.checkbox ? '\u2713' : '\u2717';
    case 'url':
      return prop.url ?? '';
    case 'email':
      return prop.email ?? '';
    case 'phone_number':
      return prop.phone_number ?? '';
    case 'status':
      return prop.status?.name ?? '';
    default:
      return '';
  }
}

export function useNotionDatabases() {
  return useQuery({
    queryKey: ['notion-databases'],
    queryFn: async () => {
      const result = await searchNotionDatabases() as NotionProxyResponse;
      if (!result.success) throw new Error(result.error);
      return (result.results ?? []) as NotionDatabaseSummary[];
    },
  });
}

export function useNotionDatabasePages(databaseId: string | null) {
  return useQuery({
    queryKey: ['notion-database-pages', databaseId],
    queryFn: async () => {
      if (!databaseId) return [];
      const result = await queryNotionDatabase(databaseId) as NotionProxyResponse;
      if (!result.success) throw new Error(result.error);
      return (result.results ?? []) as unknown[];
    },
    enabled: !!databaseId,
  });
}

export function useSyncConfigs() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['notion-sync-configs', user?.userId],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery({
        table: 'notion_sync_config',
        select: '*',
        order: { column: 'created_at', ascending: false },
      });
      return data as NotionSyncConfig[];
    },
    enabled: !!user,
    staleTime: 5 * 60_000,
  });
}

export function useCachedPages(syncConfigId: string | null) {
  return useQuery({
    queryKey: ['notion-cached-pages', syncConfigId],
    queryFn: async () => {
      if (!syncConfigId) return [];
      const { data } = await apiClient.dbQuery({
        table: 'notion_cached_pages',
        select: '*',
        filters: [{ column: 'sync_config_id', op: 'eq', value: syncConfigId }],
        order: { column: 'cached_at', ascending: false },
        limit: 200,
      });
      return data as unknown[];
    },
    enabled: !!syncConfigId,
  });
}

export function useAddSyncConfig() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      notionDatabaseId,
      databaseName,
      syncDirection,
    }: {
      notionDatabaseId: string;
      databaseName: string;
      syncDirection: 'read' | 'write' | 'both';
    }) => {
      if (!user) throw new Error('Not authenticated');

      const { data } = await apiClient.dbInsert('notion_sync_config', {
        user_id: user.userId,
        notion_database_id: notionDatabaseId,
        database_name: databaseName,
        sync_direction: syncDirection,
      });

      return (data as unknown[])?.[0];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-sync-configs'] });
      toast({ title: 'Database connected', description: 'Notion database has been linked.' });
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useRemoveSyncConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (configId: string) => {
      await apiClient.dbDelete('notion_sync_config', [
        { column: 'id', op: 'eq', value: configId },
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-sync-configs'] });
      toast({ title: 'Database disconnected' });
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useCreateNotionPage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      databaseId,
      properties,
      content,
    }: {
      databaseId: string;
      properties: Record<string, unknown>;
      content?: unknown[];
    }) => {
      const result = await createNotionPage(databaseId, properties, content) as NotionProxyResponse;
      if (!result.success) throw new Error(result.error);
      return result.page;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-database-pages'] });
      toast({ title: 'Page created', description: 'New page added to Notion.' });
    },
    onError: (error) => {
      toast({ title: 'Error creating page', description: error.message, variant: 'destructive' });
    },
  });
}

export function useUpdateNotionPage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      pageId,
      properties,
    }: {
      pageId: string;
      properties: Record<string, unknown>;
    }) => {
      const result = await updateNotionPage(pageId, properties) as NotionProxyResponse;
      if (!result.success) throw new Error(result.error);
      return result.page;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notion-database-pages'] });
      toast({ title: 'Page updated' });
    },
    onError: (error) => {
      toast({ title: 'Error updating page', description: error.message, variant: 'destructive' });
    },
  });
}

export interface WebhookEvent {
  id: string;
  processed: boolean;
  event_type: string;
  notion_page_id: string | null;
  notion_database_id: string | null;
  created_at: string;
}

export function useWebhookEvents() {
  return useQuery({
    queryKey: ['notion-webhook-events'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery({
        table: 'notion_webhook_events',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 50,
      });
      return (data ?? []) as WebhookEvent[];
    },
    refetchInterval: 10000,
  });
}
