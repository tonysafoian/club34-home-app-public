const PROJECT_ID = 'b5561696-27c3-437d-a6f3-c33ce05a412f';

export function isAllowedOrigin(origin: string): boolean {
  if (origin === 'https://example.com' || origin === 'https://www.example.com') return true;
  if (origin === 'https://club34.pages.dev') return true;
  if (origin === 'https://club34.ai' || origin === 'https://www.club34.ai') return true;
  return false;
}

export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowedOrigin = isAllowedOrigin(origin) ? origin : 'https://example.com';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-correlation-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  };
}
