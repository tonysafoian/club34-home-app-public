import { useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import { useSyncConfigs } from './useNotion';
import { queryNotionDatabase, batchGetPageTitles, batchGetNotionUsers } from '@/lib/api/notion';
import { format, subDays, isAfter, isBefore, parseISO } from 'date-fns';

type EventCategory = 'updates' | 'new' | 'completions';

interface NotionPropertyValue {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  date?: { start?: string } | null;
  status?: { name?: string } | null;
  select?: { name?: string } | null;
  checkbox?: boolean | null;
  people?: Array<{ name?: string; person?: { email?: string } }>;
}

interface NotionPayload {
  enriched_status?: string;
  status?: string;
  properties?: Record<string, NotionPropertyValue>;
  authors?: Array<{ id?: string }>;
  entity?: { id?: string };
  data?: {
    parent?: { type?: string; id?: string };
  };
}

interface NotionWebhookEventRow {
  id: string;
  event_type: string;
  payload: NotionPayload | null;
  created_at: string;
  notion_page_id?: string | null;
  notion_database_id?: string | null;
}

interface SyncConfigRow {
  id: string;
  notion_database_id: string;
  database_name?: string | null;
}

interface NotionQueryResultPage {
  id: string;
  url?: string | null;
  properties?: Record<string, NotionPropertyValue>;
}

interface NotionQueryResult {
  success?: boolean;
  results?: NotionQueryResultPage[];
}

function classifyEvent(event: {
  event_type: string;
  payload: NotionPayload | null;
}): EventCategory {
  const { event_type, payload } = event;

  if (payload && typeof payload === 'object') {
    const data = payload;
    const statusValue =
      data?.enriched_status ??
      data?.properties?.Status?.status?.name ??
      data?.properties?.status?.status?.name ??
      data?.status;
    if (
      typeof statusValue === 'string' &&
      /^(done|complete|completed)$/i.test(statusValue)
    ) {
      return 'completions';
    }
  }

  if (
    event_type === 'page.created' ||
    event_type === 'page.content_created'
  ) {
    return 'new';
  }

  return 'updates';
}

export interface DailyActivity {
  date: string;
  updates: number;
  new: number;
  completions: number;
  tigerden_updates: number;
  tigerden_new: number;
  tigerden_completions: number;
  club34_updates: number;
  club34_new: number;
  club34_completions: number;
}

const EMPTY_DAY = {
  updates: 0, new: 0, completions: 0,
  tigerden_updates: 0, tigerden_new: 0, tigerden_completions: 0,
  club34_updates: 0, club34_new: 0, club34_completions: 0,
};

const TIGERDEN_DATABASE_ID = '2b8e96d8-93fa-80cc-b1fa-fa4eef48c6fe';
const CLUB34_DATABASE_ID = '2b8e96d8-93fa-80bb-9428-cd132f827553';

const BOT_AUTHOR_IDS = new Set([
  '00000000-0000-0000-0000-000000000005',
]);

function isHumanAuthored(payload: NotionPayload | null): boolean {
  if (!payload?.authors?.length) return true;
  const authorId = payload.authors[0]?.id;
  if (!authorId) return true;
  return !BOT_AUTHOR_IDS.has(authorId);
}

function getProjectFromPayload(
  payload: NotionPayload | null,
  pageToDatabaseMap: Map<string, string>
): 'tigerden' | 'club34' {
  if (!payload?.data?.parent) return 'club34';
  const parentType = payload.data.parent.type;
  const parentId = payload.data.parent.id;

  if (parentType === 'database') {
    return parentId === TIGERDEN_DATABASE_ID ? 'tigerden' : 'club34';
  }

  if (parentType === 'page' && parentId) {
    const dbId = pageToDatabaseMap.get(parentId);
    if (dbId === TIGERDEN_DATABASE_ID) return 'tigerden';
  }

  return 'club34';
}

export function useNotionActivityStats(days: number = 14) {
  return useQuery({
    queryKey: ['notion-activity-stats', days],
    queryFn: async () => {
      const since = subDays(new Date(), days).toISOString();

      const { data } = await apiClient.dbQuery<NotionWebhookEventRow[]>({
        table: 'notion_webhook_events',
        select: 'event_type, payload, created_at',
        filters: [{ column: 'created_at', op: 'gte', value: since }],
        order: { column: 'created_at', ascending: true },
      });

      const pageToDatabaseMap = new Map<string, string>();
      for (const event of data ?? []) {
        const payload = event.payload;
        if (payload?.data?.parent?.type === 'database') {
          const pageId = payload.entity?.id;
          if (pageId) {
            pageToDatabaseMap.set(pageId, payload.data?.parent?.id ?? '');
          }
        }
      }

      const map = new Map<string, DailyActivity>();

      const today = new Date();
      for (let i = days - 1; i >= 0; i--) {
        const d = format(subDays(today, i), 'yyyy-MM-dd');
        map.set(d, { date: d, ...EMPTY_DAY });
      }

      for (const event of data ?? []) {
        const payload = event.payload;
        if (!isHumanAuthored(payload)) continue;
        const dateKey = format(new Date(event.created_at), 'yyyy-MM-dd');
        const category = classifyEvent(event);
        const project = getProjectFromPayload(payload, pageToDatabaseMap);
        const entry = map.get(dateKey);
        if (entry) {
          entry[category]++;
          const wsKey = `${project}_${category}` as keyof DailyActivity;
          (entry[wsKey] as number)++;
        }
      }

      return Array.from(map.values());
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export type WebhookHealthStatus = 'healthy' | 'warning' | 'stale' | 'never';

export interface NotionWebhookHealth {
  lastEventAt: string | null;
  countLast24h: number;
  status: WebhookHealthStatus;
}

export function useNotionWebhookHealth() {
  return useQuery<NotionWebhookHealth>({
    queryKey: ['notion-webhook-health'],
    queryFn: async () => {
      const since = subDays(new Date(), 1).toISOString();

      const [latestRes, count] = await Promise.all([
        apiClient.dbQuery<{ created_at: string }[]>({
          table: 'notion_webhook_events',
          select: 'created_at',
          order: { column: 'created_at', ascending: false },
          limit: 1,
        }),
        apiClient.dbCount('notion_webhook_events', [
          { column: 'created_at', op: 'gte', value: since },
        ]),
      ]);

      const lastEventAt = latestRes.data?.[0]?.created_at ?? null;

      let status: WebhookHealthStatus;
      if (!lastEventAt) {
        status = 'never';
      } else {
        const ageMs = Date.now() - new Date(lastEventAt).getTime();
        if (ageMs < 60 * 60_000) status = 'healthy';
        else if (ageMs < 24 * 60 * 60_000) status = 'warning';
        else status = 'stale';
      }

      return { lastEventAt, countLast24h: count, status };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useNotionActivityRealtime() {
  const queryClient = useQueryClient();

  const handleNotionEvent = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['notion-activity-stats'] });
    queryClient.invalidateQueries({ queryKey: ['notion-webhook-health'] });
  }, [queryClient]);

  const handleSyncConfigChange = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['notion-sync-configs'] });
    queryClient.invalidateQueries({ queryKey: ['notion-recurring-tasks'] });
  }, [queryClient]);

  useSocketEvent('notion:event', handleNotionEvent);
  useSocketEvent('notion:sync-config', handleSyncConfigChange);
}

export interface NotionDayEvent {
  id: string;
  event_type: string;
  category: EventCategory;
  notion_page_id: string | null;
  title: string | null;
  author: string | null;
  created_at: string;
}

export function useNotionDayEvents(date: string | null) {
  return useQuery({
    queryKey: ['notion-day-events', date],
    queryFn: async () => {
      if (!date) return [];
      const dayStart = new Date(`${date}T00:00:00`).toISOString();
      const dayEnd = new Date(`${date}T23:59:59.999`).toISOString();

      const { data } = await apiClient.dbQuery<NotionWebhookEventRow[]>({
        table: 'notion_webhook_events',
        select: 'id, event_type, payload, created_at, notion_page_id, notion_database_id',
        filters: [
          { column: 'created_at', op: 'gte', value: dayStart },
          { column: 'created_at', op: 'lte', value: dayEnd },
        ],
        order: { column: 'created_at', ascending: false },
      });

      const pageToDatabaseMap = new Map<string, string>();
      for (const row of data ?? []) {
        const payload = row.payload;
        if (payload?.data?.parent?.type === 'database') {
          const pageId = payload.entity?.id;
          if (pageId) pageToDatabaseMap.set(pageId, payload.data?.parent?.id ?? '');
        }
      }

      const events = (data ?? []).filter((e) => {
        const payload = e.payload;
        if (!isHumanAuthored(payload)) return false;
        if (e.notion_database_id === TIGERDEN_DATABASE_ID) return false;
        if (payload?.data?.parent?.type === 'database' && payload?.data?.parent?.id === TIGERDEN_DATABASE_ID) {
          return false;
        }
        if (payload?.data?.parent?.type === 'page') {
          const dbId = pageToDatabaseMap.get(payload.data?.parent?.id ?? '');
          if (dbId === TIGERDEN_DATABASE_ID) return false;
        }
        return true;
      });

      const pageIds = [...new Set(
        events.map((e) => e.notion_page_id).filter((id): id is string => !!id)
      )];

      let titles: Record<string, string | null> = {};
      if (pageIds.length > 0) {
        try {
          titles = await batchGetPageTitles(pageIds);
        } catch (err) {
          console.error('Failed to fetch page titles:', err);
        }
      }

      const authorIds = [...new Set(
        events
          .map((e) => {
            const payload = e.payload;
            return payload?.authors?.[0]?.id;
          })
          .filter((id): id is string => !!id)
      )];

      let authorNames: Record<string, string | null> = {};
      if (authorIds.length > 0) {
        try {
          authorNames = await batchGetNotionUsers(authorIds);
        } catch (err) {
          console.error('Failed to fetch author names:', err);
        }
      }

      return events.map((e) => {
        const payload = e.payload;
        const authorId = payload?.authors?.[0]?.id;
        return {
          id: e.id,
          event_type: e.event_type,
          category: classifyEvent(e),
          notion_page_id: e.notion_page_id,
          title: (e.notion_page_id ? titles[e.notion_page_id] : null) ?? null,
          author: authorId ? (authorNames[authorId] ?? null) : null,
          created_at: e.created_at,
        };
      }) as NotionDayEvent[];
    },
    enabled: !!date,
  });
}

export type TaskStatus = 'on-track' | 'overdue' | 'upcoming';
export type TaskType = 'recurring' | 'project';
export type StatusColor = 'red' | 'yellow' | 'green';

export interface TaskLastUpdate {
  description: string;
  author: string | null;
  date: string;
}

export interface RecurringTask {
  id: string;
  name: string;
  status: TaskStatus;
  statusColor: StatusColor;
  dueDate: string | null;
  lastCompleted: string | null;
  notionUrl: string | null;
  rawStatus: string;
  taskType: TaskType;
  assignedTo: string | null;
  databaseName: string | null;
  updateCount?: number;
  lastUpdate?: TaskLastUpdate | null;
}

function classifyStatusColor(rawStatus: string, isChecked: boolean | null): StatusColor {
  if (isChecked === true || /^(done|complete|completed)$/i.test(rawStatus)) return 'green';
  if (/^(in progress|doing|in review|active|started|working)$/i.test(rawStatus)) return 'yellow';
  if (/^(not started|todo|to do|backlog|blocked|waiting)$/i.test(rawStatus)) return 'red';
  return rawStatus ? 'yellow' : 'red';
}

function extractDateProp(properties: Record<string, NotionPropertyValue>): string | null {
  const dateKeys = ['Due Date', 'Due date', 'Due', 'due_date', 'due', 'Date', 'date', 'Deadline', 'deadline'];
  for (const key of dateKeys) {
    const prop = properties[key];
    if (prop?.type === 'date' && prop.date?.start) {
      return prop.date.start;
    }
  }
  return null;
}

function extractStatusProp(properties: Record<string, NotionPropertyValue>): string {
  const statusKeys = ['Status', 'status'];
  for (const key of statusKeys) {
    const prop = properties[key];
    if (prop?.type === 'status' && prop.status?.name) {
      return prop.status.name;
    }
    if (prop?.type === 'select' && prop.select?.name) {
      return prop.select.name;
    }
  }
  return '';
}

function extractCheckbox(properties: Record<string, NotionPropertyValue>): boolean | null {
  const cbKeys = ['Completed', 'completed', 'Done', 'done', 'Complete', 'complete'];
  for (const key of cbKeys) {
    const prop = properties[key];
    if (prop?.type === 'checkbox') {
      return prop.checkbox ?? null;
    }
  }
  return null;
}

function extractTitle(properties: Record<string, NotionPropertyValue>): string {
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (prop?.type === 'title' && (prop.title?.length ?? 0) > 0) {
      return (prop.title ?? []).map((t) => t.plain_text).join('');
    }
  }
  return 'Untitled';
}

function extractAssignedTo(properties: Record<string, NotionPropertyValue>): string | null {
  const personKeys = ['Assign', 'assign', 'Assigned To', 'Assigned to', 'assigned_to', 'Person', 'person', 'Owner', 'owner', 'Assignee', 'assignee'];
  for (const key of personKeys) {
    const prop = properties[key];
    if (prop?.type === 'people' && (prop.people?.length ?? 0) > 0) {
      return (prop.people ?? []).map((p) => p.name ?? p.person?.email ?? 'Unknown').join(', ');
    }
  }
  return null;
}

function classifyTaskType(databaseName: string | null): TaskType {
  if (!databaseName) return 'project';
  const lower = databaseName.toLowerCase();
  if (lower.includes('recurring') || lower.includes('routine') || lower.includes('habit')) return 'recurring';
  return 'project';
}

function classifyTaskStatus(
  rawStatus: string,
  dueDate: string | null,
  isChecked: boolean | null
): TaskStatus {
  const isDone =
    isChecked === true ||
    /^(done|complete|completed)$/i.test(rawStatus);

  if (!dueDate) {
    return isDone ? 'on-track' : 'upcoming';
  }

  const due = parseISO(dueDate);
  const now = new Date();

  if (isDone) return 'on-track';
  if (isBefore(due, now)) return 'overdue';
  return 'upcoming';
}

export function useNotionRecurringTasks() {
  const { data: syncConfigs } = useSyncConfigs();

  const configs = syncConfigs as SyncConfigRow[] | undefined;

  return useQuery({
    queryKey: ['notion-recurring-tasks', configs?.map((c) => c.id)],
    queryFn: async () => {
      if (!configs?.length) return [];

      const allTasks: RecurringTask[] = [];
      const seenPageIds = new Set<string>();
      const configsToFetch = configs.filter((c) => c.notion_database_id !== TIGERDEN_DATABASE_ID);
      const dbResults = await Promise.allSettled(
        configsToFetch.map((config) => queryNotionDatabase(config.notion_database_id).then((result) => ({ config, result })))
      );

      for (const settled of dbResults) {
        if (settled.status !== 'fulfilled') continue;
        const { config, result } = settled.value;
        const queryResult = result as NotionQueryResult;
        if (!queryResult.success || !queryResult.results) continue;

        for (const page of queryResult.results) {
          const properties = page.properties ?? {};
          const dueDate = extractDateProp(properties);
          const rawStatus = extractStatusProp(properties);
          const isChecked = extractCheckbox(properties);

          const assignedTo = extractAssignedTo(properties);
          const dbName = config.database_name ?? null;

          if (!dueDate && !rawStatus && isChecked === null) continue;

          if (seenPageIds.has(page.id)) continue;
          seenPageIds.add(page.id);

          allTasks.push({
            id: page.id,
            name: extractTitle(properties),
            status: classifyTaskStatus(rawStatus, dueDate, isChecked),
            statusColor: classifyStatusColor(rawStatus, isChecked),
            dueDate,
            lastCompleted: null,
            notionUrl: page.url ?? null,
            rawStatus,
            taskType: classifyTaskType(dbName),
            assignedTo,
            databaseName: dbName,
          });
        }
      }

      const projectTasks = allTasks.filter((t) => t.taskType === 'project');
      if (projectTasks.length > 0) {
        const pageIds = projectTasks.map((t) => t.id).filter(Boolean);
        try {
          const { data: events } = await apiClient.dbQuery<NotionWebhookEventRow[]>({
            table: 'notion_webhook_events',
            select: 'notion_page_id, event_type, payload, created_at',
            filters: [{ column: 'notion_page_id', op: 'in', value: pageIds }],
            order: { column: 'created_at', ascending: false },
          });

          if (events?.length) {
            const humanEvents = events.filter((e) =>
              isHumanAuthored(e.payload)
            );

            const countMap = new Map<string, number>();
            const latestMap = new Map<string, typeof humanEvents[0]>();
            for (const ev of humanEvents) {
              if (!ev.notion_page_id) continue;
              countMap.set(ev.notion_page_id, (countMap.get(ev.notion_page_id) ?? 0) + 1);
              if (!latestMap.has(ev.notion_page_id)) {
                latestMap.set(ev.notion_page_id, ev);
              }
            }

            const authorIds = [...new Set(
              [...latestMap.values()]
                .map((e) => e.payload?.authors?.[0]?.id)
                .filter((id): id is string => !!id)
            )];
            let authorNames: Record<string, string | null> = {};
            if (authorIds.length > 0) {
              try {
                authorNames = await batchGetNotionUsers(authorIds);
              } catch (e) { console.error('Notion activity enrichment error:', e); }
            }

            for (const task of projectTasks) {
              task.updateCount = countMap.get(task.id) ?? 0;
              const latest = latestMap.get(task.id);
              if (latest) {
                const payload = latest.payload;
                const authorId = payload?.authors?.[0]?.id;
                task.lastUpdate = {
                  description: latest.event_type.replace(/\./g, ' \u2192 ').replace(/_/g, ' '),
                  author: authorId ? (authorNames[authorId] ?? null) : null,
                  date: latest.created_at,
                };
              }
            }
          }
        } catch (e) { console.error('Notion activity enrichment error:', e); }
      }

      return allTasks;
    },
    enabled: !!configs?.length,
    staleTime: 5 * 60_000,
  });
}
