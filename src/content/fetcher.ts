import * as cheerio from 'cheerio';
import type { PageContentRow } from '../types.js';
import { proxyAwareFetch } from './httpClient.js';

const USER_AGENT =
  'Mozilla/5.0 (compatible; GSC-Content-Recommendations/0.1; +https://github.com/tenterms/reactimus)';

/** Fetch a live page and extract the structured content used for analysis. */
export async function fetchPageContent(url: string, timeoutMs = 20000): Promise<PageContentRow> {
  const lastFetched = new Date().toISOString();
  try {
    const res = await proxyAwareFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = res.ok ? await res.text() : '';
    const parsed = parseHtml(html);
    return { url, httpStatus: res.status, lastFetched, ...parsed };
  } catch (err) {
    return {
      url,
      httpStatus: 0,
      canonicalUrl: '',
      titleTag: '',
      metaDescription: '',
      h1: '',
      h2s: [],
      bodyText: `FETCH ERROR: ${(err as Error).message}`,
      wordCount: 0,
      lastFetched,
    };
  }
}

export function parseHtml(html: string): Omit<PageContentRow, 'url' | 'httpStatus' | 'lastFetched'> {
  if (!html) {
    return {
      canonicalUrl: '',
      titleTag: '',
      metaDescription: '',
      h1: '',
      h2s: [],
      bodyText: '',
      wordCount: 0,
    };
  }
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe').remove();

  const titleTag = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const canonicalUrl = $('link[rel="canonical"]').attr('href')?.trim() ?? '';
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim();
  const h2s = $('h2')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);

  // Prefer main content containers; fall back to body.
  const mainEl = $('main, article, [role="main"]').first();
  const container = mainEl.length ? mainEl : $('body');
  container.find('nav, header, footer, aside').remove();
  const bodyText = container.text().replace(/\s+/g, ' ').trim();

  return {
    canonicalUrl,
    titleTag,
    metaDescription,
    h1,
    h2s,
    bodyText,
    wordCount: bodyText ? bodyText.split(/\s+/).length : 0,
  };
}
