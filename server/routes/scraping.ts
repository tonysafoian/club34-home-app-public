import { Router } from 'express';

const router = Router();

function fetchT(input: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input as any, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

router.post('/api/firecrawl-scrape', async (req: any, res: any) => {
  try {
    const { url, options } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'URL is required' });

    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'Firecrawl not configured' });

    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) {
      formattedUrl = `https://${formattedUrl}`;
    }

    console.log('Scraping URL:', formattedUrl);
    const response = await fetchT('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: formattedUrl,
        formats: options?.formats || ['markdown'],
        onlyMainContent: options?.onlyMainContent ?? true,
        waitFor: options?.waitFor,
        location: options?.location,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Firecrawl scrape error:', data);
      return res.json({ success: false, error: data.error || `Firecrawl returned ${response.status}` });
    }
    res.json(data);
  } catch (error: any) {
    console.error('Scrape error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/firecrawl-search', async (req: any, res: any) => {
  try {
    const { query, options } = req.body;
    if (!query) return res.status(400).json({ success: false, error: 'Query is required' });

    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'Firecrawl not configured' });

    console.log('Searching:', query);
    const response = await fetchT('https://api.firecrawl.dev/v1/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        limit: options?.limit || 10,
        lang: options?.lang,
        country: options?.country,
        tbs: options?.tbs,
        scrapeOptions: options?.scrapeOptions,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Firecrawl search error:', data);
      return res.json({ success: false, error: data.error || `Firecrawl returned ${response.status}` });
    }
    res.json(data);
  } catch (error: any) {
    console.error('Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
