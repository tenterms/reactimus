import { XMLParser } from 'fast-xml-parser';

const USER_AGENT = 'Mozilla/5.0 (compatible; GSC-Content-Recommendations/0.1)';

/**
 * Collect URLs from a sitemap (following one level of sitemap-index nesting).
 * Used to seed the Site URL Inventory tab.
 */
export async function fetchSitemapUrls(sitemapUrl: string, maxUrls = 2000): Promise<string[]> {
  const parser = new XMLParser();
  const urls: string[] = [];

  const load = async (target: string): Promise<unknown> => {
    const res = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Sitemap fetch failed (${res.status}) for ${target}`);
    return parser.parse(await res.text());
  };

  const root = (await load(sitemapUrl)) as {
    sitemapindex?: { sitemap: Array<{ loc: string }> | { loc: string } };
    urlset?: { url: Array<{ loc: string }> | { loc: string } };
  };

  const collect = (doc: typeof root) => {
    const entries = doc.urlset?.url;
    if (!entries) return;
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (entry.loc && urls.length < maxUrls) urls.push(String(entry.loc).trim());
    }
  };

  collect(root);

  if (root.sitemapindex?.sitemap) {
    const children = Array.isArray(root.sitemapindex.sitemap)
      ? root.sitemapindex.sitemap
      : [root.sitemapindex.sitemap];
    for (const child of children) {
      if (urls.length >= maxUrls) break;
      try {
        collect((await load(String(child.loc).trim())) as typeof root);
      } catch (err) {
        console.warn(`Skipping child sitemap ${child.loc}: ${(err as Error).message}`);
      }
    }
  }

  return urls;
}
