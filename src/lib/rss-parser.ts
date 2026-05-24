import { JobItem } from "@/types/job";

export class RSSParseError extends Error {
  constructor(message: string, public readonly feedUrl: string) {
    super(message);
    this.name = "RSSParseError";
  }
}

/**
 * Per-feed conditional-fetch cache.
 *
 * Survives between invocations of the same warm function instance, dies on
 * cold start. Vercel Fluid keeps functions warm during cron streaks so this
 * pays off heavily — most ticks fetch nothing and re-emit the cached job
 * list, skipping cheerio/regex parsing entirely.
 *
 * Safety: the server only returns 304 when the response body byte-equals
 * the prior response. Any feed change → 200 + fresh body → we re-parse.
 * The only way to lose data here is a server lying about freshness, which
 * would break every HTTP caching client and is out of scope for us.
 *
 * The TTL caps cache age in case a server returns 304 indefinitely without
 * actually being current (rare but observed in some malformed providers).
 */
interface FeedCacheEntry {
  etag?: string;
  lastModified?: string;
  jobs: JobItem[];
  cachedAt: number;
}
const FEED_CACHE = new Map<string, FeedCacheEntry>();
const FEED_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour hard ceiling

/**
 * Parses a single RSS feed and extracts job items.
 * Uses If-None-Match / If-Modified-Since to short-circuit when feed unchanged.
 */
async function parseSingleFeed(url: string): Promise<JobItem[]> {
  try {
    const cached = FEED_CACHE.get(url);
    const cacheIsFresh = cached && (Date.now() - cached.cachedAt) < FEED_CACHE_MAX_AGE_MS;

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; JobMonitor/1.0)',
    };
    if (cacheIsFresh && cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }
    if (cacheIsFresh && cached?.lastModified) {
      headers['If-Modified-Since'] = cached.lastModified;
    }

    const response = await fetch(url, {
      headers,
      // No browser/Next cache layer — we manage staleness ourselves above.
      cache: 'no-store',
      next: { revalidate: 0 },
    });

    // 304 Not Modified — server confirms our cached body is still current.
    // Return the cached jobs and avoid the parse cost entirely.
    if (response.status === 304 && cached) {
      console.log(`[RSS] 304 cached (${cached.jobs.length} jobs): ${url.substring(0, 60)}...`);
      // Refresh the cachedAt so the cache TTL stays sliding while the feed
      // is genuinely stable. Without this, a perpetually-unchanged feed
      // would force a re-parse every hour for no reason.
      cached.cachedAt = Date.now();
      return cached.jobs;
    }

    if (!response.ok) {
      throw new RSSParseError(
        `Failed to fetch feed: ${response.status} ${response.statusText}`,
        url
      );
    }

    const xmlText = await response.text();
    console.log(`[RSS] 200 (${xmlText.length}b): ${url.substring(0, 60)}...`);
    const jobs = extractJobsFromXML(xmlText);
    jobs.forEach(job => job.sourceUrl = url);

    // Store the parsed jobs + the validators for the next fetch.
    FEED_CACHE.set(url, {
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      jobs,
      cachedAt: Date.now(),
    });

    return jobs;
  } catch (error) {
    if (error instanceof RSSParseError) {
      throw error;
    }
    throw new RSSParseError(
      `Error parsing feed: ${error instanceof Error ? error.message : String(error)}`,
      url
    );
  }
}

/**
 * Extract company name from LinkedIn job URL
 * Pattern: /-at-{company-name}-in-/ or /-at-{company-name}-{numbers}
 */
function extractCompanyFromLink(link: string): string | undefined {
  const atIndex = link.indexOf('-at-');
  if (atIndex === -1) return undefined;

  const afterAt = link.substring(atIndex + 4); // Skip '-at-'

  // Find end of company name: either '-in-' or first digit
  const inIndex = afterAt.indexOf('-in-');
  const digitMatch = afterAt.match(/\-\d/);

  let companyPart: string;
  if (inIndex !== -1) {
    companyPart = afterAt.substring(0, inIndex);
  } else if (digitMatch && digitMatch.index !== undefined) {
    companyPart = afterAt.substring(0, digitMatch.index);
  } else {
    return undefined;
  }

  // Convert kebab-case to Title Case
  const company = companyPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();

  return company || undefined;
}

/**
 * Extract location from LinkedIn job URL
 * Pattern: /-in-{location}-{numbers}
 */
function extractLocationFromLink(link: string): string | undefined {
  const inIndex = link.indexOf('-in-');
  if (inIndex === -1) return undefined;

  const afterIn = link.substring(inIndex + 4); // Skip '-in-'

  // Find end of location: first digit
  const digitMatch = afterIn.match(/\-\d/);
  if (!digitMatch || digitMatch.index === undefined) return undefined;

  const locationPart = afterIn.substring(0, digitMatch.index);

  // Convert kebab-case to Title Case
  const location = locationPart
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .trim();

  return location || undefined;
}

/**
 * Extracts job items from RSS XML text
 */
function extractJobsFromXML(xmlText: string): JobItem[] {
  const items: JobItem[] = [];
  const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/g) || [];

  for (const itemXml of itemMatches) {
    const title = extractXMLTag(itemXml, 'title');
    const link = extractXMLTag(itemXml, 'link');
    const pubDate = extractXMLTag(itemXml, 'pubDate');
    const description = extractXMLTag(itemXml, 'description');

    if (title && link && pubDate) {
      const cleanLink = link.trim();

      // Extract company and location from link
      const company = extractCompanyFromLink(cleanLink);
      const location = extractLocationFromLink(cleanLink);

      items.push({
        title: cleanCDATA(title),
        link: cleanLink,
        pubDate: pubDate.trim(),
        description: cleanCDATA(description),
        company,
        location,
      });
    }
  }

  return items;
}

/**
 * Extracts content from an XML tag
 */
function extractXMLTag(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? match[1] : "";
}

/**
 * Removes CDATA tags and trims content
 */
function cleanCDATA(text: string): string {
  return text.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

/**
 * Parses multiple RSS feeds and returns deduplicated job items
 */
export async function parseRSSFeeds(feedUrls: string[]): Promise<JobItem[]> {
  const feedPromises = feedUrls.map(url =>
    parseSingleFeed(url).catch(error => {
      console.error(`Error fetching feed ${url}:`, error);
      return [] as JobItem[];
    })
  );

  const feedResults = await Promise.all(feedPromises);

  // Deduplicate jobs by link (in-memory only)
  // Only consider URLs that contain "http" as valid
  const seenLinks = new Set<string>();
  const allJobs: JobItem[] = [];

  for (const jobs of feedResults) {
    for (const job of jobs) {
      const normalizedLink = job.link.toLowerCase().trim();

      // Skip jobs with invalid URLs (must contain http)
      if (!normalizedLink.includes('http')) {
        console.warn(`Skipping job with invalid URL: "${job.link}" - ${job.title}`);
        continue;
      }

      if (!seenLinks.has(normalizedLink)) {
        seenLinks.add(normalizedLink);
        allJobs.push(job);
      }
    }
  }

  return allJobs;
}

/**
 * Filters jobs posted within the specified time interval
 */
export function filterRecentJobs(
  jobs: JobItem[],
  intervalMinutes: number
): JobItem[] {
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - (intervalMinutes + 1) * 60 * 1000);

  return jobs.filter(job => {
    try {
      const jobDate = new Date(job.pubDate);
      return jobDate >= cutoffTime && jobDate <= now;
    } catch {
      // Invalid date format, skip this job
      return false;
    }
  });
}
