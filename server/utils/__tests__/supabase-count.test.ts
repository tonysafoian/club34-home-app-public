import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock('../../lib/db.js', () => ({
  query: queryMock,
}));

import { getServiceClient } from '../supabase.js';

describe('server Supabase count-only selects', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('uses COUNT(*) with the same filters and does not fetch rows for head requests', async () => {
    queryMock.mockResolvedValue({ rows: [{ count: '7' }], rowCount: 1 });

    const result = await getServiceClient()
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', 'user-1')
      .is('read_at', null);

    expect(queryMock).toHaveBeenCalledOnce();
    expect(queryMock).toHaveBeenCalledWith(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      ['user-1'],
    );
    expect(result).toEqual({ data: null, error: null, count: 7 });
  });
});