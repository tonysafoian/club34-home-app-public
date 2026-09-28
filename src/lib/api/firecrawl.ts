import { apiClient } from '@/lib/apiClient';

type FirecrawlResponse<T = unknown> = {
  success: boolean;
  error?: string;
  data?: T;
  [key: string]: unknown;
};

type ScrapeOptions = {
  formats?: string[];
  onlyMainContent?: boolean;
  waitFor?: number;
};

type FirecrawlScrapeData = {
  markdown?: string;
  links?: string[];
  metadata?: { title?: string; [key: string]: unknown };
};

type SearchOptions = {
  limit?: number;
  lang?: string;
  country?: string;
  tbs?: string;
  scrapeOptions?: { formats?: string[] };
};

export const firecrawlApi = {
  async scrape(url: string, options?: ScrapeOptions): Promise<FirecrawlResponse<FirecrawlScrapeData>> {
    try {
      return await apiClient.post<FirecrawlResponse<FirecrawlScrapeData>>('/api/firecrawl-scrape', { url, options });
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async search(query: string, options?: SearchOptions): Promise<FirecrawlResponse> {
    try {
      return await apiClient.post<FirecrawlResponse>('/api/firecrawl-search', { query, options });
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
