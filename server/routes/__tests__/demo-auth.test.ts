/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';

vi.mock('../../storage', () => ({
  storage: {
    getProfileByUserId: vi.fn(async () => null),
    createProfile: vi.fn(async (p) => ({ ...p, id: 'profile-1' })),
    createUserRole: vi.fn(async () => ({ id: 'role-1' })),
  },
}));

const authRouter = (await import('../auth.js')).default;

interface MockResp {
  status: number;
  body: any;
  headers: Record<string, any>;
}

function invoke(method: string, path: string, headers: Record<string, string> = {}): Promise<MockResp> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(authRouter);

    let status = 200;
    const resHeaders: Record<string, any> = {};

    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path: path.split('?')[0],
      headers: { ...headers },
      cookies: {},
      query: {},
      body: {},
      header: (name: string) => headers[name.toLowerCase()],
    };

    const res: any = {
      status: (code: number) => {
        status = code;
        return res;
      },
      json: (data: any) => resolve({ status, body: data, headers: resHeaders }),
      cookie: (name: string, val: string, opts: any) => {
        resHeaders['set-cookie'] = `${name}=${val}`;
      },
      clearCookie: () => {},
      setHeader: (name: string, val: any) => {
        resHeaders[name.toLowerCase()] = val;
      },
      end: () => resolve({ status, body: null, headers: resHeaders }),
    };

    (app as any).handle(req, res, (err: any) => {
      if (err) reject(err);
      else resolve({ status, body: null, headers: resHeaders });
    });
  });
}

describe('Demo Auth Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully generates a demo admin token and sets auth cookie', async () => {
    const res = await invoke('POST', '/api/auth/demo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.userId).toBe('demo-admin');
    expect(res.body.user.roles).toContain('admin');
    expect(res.body.user.approvalStatus).toBe('approved');
    expect(res.body.token).toBeDefined();
    expect(res.headers['set-cookie']).toContain('auth_token=');
  });

  it('returns authenticated user details on /api/auth/me using bearer token', async () => {
    // 1. Get demo token
    const demoRes = await invoke('POST', '/api/auth/demo');
    const token = demoRes.body.token;

    // 2. Call /api/auth/me with Bearer token
    const meRes = await invoke('GET', '/api/auth/me', {
      authorization: `Bearer ${token}`,
    });

    expect(meRes.status).toBe(200);
    expect(meRes.body.user).toBeDefined();
    expect(meRes.body.user.userId).toBe('demo-admin');
    expect(meRes.body.user.roles).toContain('admin');
  });
});
