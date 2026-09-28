import { apiClient } from '@/lib/apiClient';

async function callNotionProxy(body: Record<string, unknown>) {
  return apiClient.post('/api/notion/proxy', body);
}

export async function searchNotionDatabases(query?: string) {
  return callNotionProxy({ action: 'search-databases', query });
}

export async function queryNotionDatabase(databaseId: string) {
  return callNotionProxy({ action: 'query-database', database_id: databaseId });
}

export async function getNotionDatabase(databaseId: string) {
  return callNotionProxy({ action: 'get-database', database_id: databaseId });
}

export async function getNotionPage(pageId: string) {
  return callNotionProxy({ action: 'get-page', page_id: pageId });
}

export async function createNotionPage(
  databaseId: string,
  properties: Record<string, unknown>,
  content?: unknown[]
) {
  return callNotionProxy({
    action: 'create-page',
    database_id: databaseId,
    properties,
    content,
  });
}

export async function updateNotionPage(
  pageId: string,
  properties: Record<string, unknown>
) {
  return callNotionProxy({
    action: 'update-page',
    page_id: pageId,
    properties,
  });
}

export async function batchGetPageTitles(pageIds: string[]): Promise<Record<string, string | null>> {
  const result = await callNotionProxy({ action: 'batch-get-page-titles', page_ids: pageIds });
  return (result as { titles?: Record<string, string | null> }).titles ?? {};
}

export async function batchGetNotionUsers(userIds: string[]): Promise<Record<string, string | null>> {
  const result = await callNotionProxy({ action: 'batch-get-users', page_ids: userIds });
  return (result as { users?: Record<string, string | null> }).users ?? {};
}

export async function searchNotionProjects(query?: string) {
  const result = await callNotionProxy({ action: 'search-projects', query });
  return (result as { results?: unknown[] }).results ?? [];
}

export async function addNotionComment(pageId: string, text: string) {
  return callNotionProxy({ action: 'add-comment', page_id: pageId, query: text });
}
