import { CronJobResult, JobItem } from "@/types/job";
import { parseRSSFeeds, filterRecentJobs } from "./rss-parser";
import { formatJobMessage } from "./job-formatter";
import { sendMessagesWithRateLimit, sendMessagesWithRateLimitTo } from "./telegram";
import { logger } from "./logger";
import { dailyJobCache } from "./daily-cache";
import { UrlCache } from "./url-cache";
import {
  RSS_FEED_URLS,
  CHECK_INTERVAL_MINUTES,
  RATE_LIMIT_DELAY_MS,
  GOAT_TELEGRAM_BOT_TOKEN,
  GOAT_TELEGRAM_CHAT_ID,
} from "@/config/constants";
import { LocationExtractor } from "./location-extractor";
import { JobMetadataExtractor } from "./job-metadata-extractor";
import { RoleTypeExtractor } from "./role-type-extractor";
import { extractJobDetails } from "./job-analyzer";

// Categories that qualify a job for the GOAT channel
const GOAT_CATEGORIES = new Set([
  "Corporate Finance & Accounting",
  "Quantitative Finance",
  "Private Equity & Venture Capital",
  "Investment Banking",
  "Data & Analytics",
  "Asset & Portfolio Management",
]);

// Companies blacklisted from the GOAT channel (case-insensitive substring match)
const GOAT_COMPANY_BLACKLIST = ["targetjobs", "greenwich", "hackajob"];

// Seniority levels that qualify for the GOAT channel
const GOAT_SENIORITY = new Set(["Mid", "Entry"]);
// Industry levels that qualify for the GOAT channel
const GOAT_INDUSTRY = new Set(["Finance"]);

// UK location terms required for all GOAT channel posts
// "uk" uses word-boundary regex to avoid matching "uk.indeed.com" etc.
const GOAT_UK_SUBSTRINGS = ["united kingdom", "london", "england", "scotland", "wales", "manchester", "birmingham", "edinburgh", "glasgow", "leeds", "bristol", "liverpool", "sheffield", "newcastle", "cardiff"];
const GOAT_UK_WORD = /\buk\b/i;

// VIP companies that pass through with just UK + Finance checks
const GOAT_VIP_COMPANIES = ["marriott", "marriot", "lloyds", "natwest", "metro"];

/**
 * Returns true if the job location OR title contains UK keywords.
 */
function isUKLocation(job: JobItem): boolean {
  const locationText = (job.location || "").toLowerCase();
  const titleText = (job.title || "").toLowerCase();
  const combined = `${locationText} ${titleText}`;
  if (GOAT_UK_WORD.test(combined)) return true;
  return GOAT_UK_SUBSTRINGS.some((term) => combined.includes(term));
}

/**
 * Returns true if the job meets the GOAT channel criteria:
 * 1. UK location or title — mandatory
 * 2. Finance industry — mandatory
 * 3. Path A: title or company contains a VIP company name
 *    OR
 *    Path B: seniority is Mid/Entry AND (has CFA/CIMA cert OR category in GOAT_CATEGORIES)
 */
function isGoatEligible(job: JobItem): boolean {
  // UK location/title is mandatory
  if (!isUKLocation(job)) {
    return false;
  }

  // Reject blacklisted companies
  const companyLower = (job.company || "").toLowerCase();
  if (GOAT_COMPANY_BLACKLIST.some((name) => companyLower.includes(name))) {
    return false;
  }

  const details = extractJobDetails(job.title);
  const company = details.company !== "N/A" ? details.company : (job.company || "");

  const metadata = JobMetadataExtractor.extractAllMetadata({
    title: details.position,
    company,
    description: job.description,
    url: job.link,
  });

  // Finance industry is mandatory for all paths
  if (!GOAT_INDUSTRY.has(metadata.industry)) {
    return false;
  }

  // Path A: VIP company match in title or company name
  const titleAndCompany = `${(job.title || "").toLowerCase()} ${companyLower}`;
  if (GOAT_VIP_COMPANIES.some((name) => titleAndCompany.includes(name))) {
    return true;
  }

  // Path B: seniority must be Mid or Entry
  if (!GOAT_SENIORITY.has(metadata.seniority)) {
    return false;
  }

  // Path B-1: CFA or CIMA certificate
  const hasBypassCert = metadata.certificates.some((cert) => {
    const c = cert.toLowerCase();
    return c.includes("cfa") || c.includes("cima");
  });
  if (hasBypassCert) {
    return true;
  }

  // Path B-2: category in GOAT_CATEGORIES
  const roleTypeMatch = RoleTypeExtractor.extractRoleType(
    details.position,
    metadata.keywords,
    job.description,
    metadata.industry,
  );

  return roleTypeMatch !== null && GOAT_CATEGORIES.has(roleTypeMatch.category);
}

// Feed URL that should only send Europe and Canada jobs
const EUROPE_CANADA_ONLY_FEED = "https://rss.app/feeds/cbDOTKxD2MnLmSzW.xml";

// Allowed countries for the filtered feed (Europe + Canada)
const ALLOWED_COUNTRIES = new Set([
  // European countries (canonical names from countries.ts)
  "United Kingdom",
  "Germany",
  "France",
  "Italy",
  "Spain",
  "Netherlands",
  "Belgium",
  "Switzerland",
  "Austria",
  "Poland",
  "Czech Republic",
  "Sweden",
  "Norway",
  "Denmark",
  "Finland",
  "Ireland",
  "Portugal",
  "Greece",
  "Hungary",
  "Romania",
  "Bulgaria",
  "Ukraine",
  "Russia",
  "Serbia",
  "Croatia",
  "Slovenia",
  "Slovakia",
  "Lithuania",
  "Latvia",
  "Estonia",
  "Cyprus",
  "Malta",
  "Iceland",
  "Luxembourg",
  "Monaco",
  "Andorra",
  "Liechtenstein",
  "San Marino",
  "Vatican City",
  "Albania",
  "North Macedonia",
  "Montenegro",
  "Bosnia and Herzegovina",
  "Moldova",
  "Belarus",
  // Canada
  //'Canada',
]);

/**
 * Filter jobs from specific feeds based on location
 * For EUROPE_CANADA_ONLY_FEED, only allow jobs from Europe or Canada
 * Uses LocationExtractor which finds countries via direct match, city lookup, or state lookup
 * Returns { filtered: JobItem[], removedCount: number }
 */
function filterJobsByFeedLocation(jobs: JobItem[]): {
  filtered: JobItem[];
  removedCount: number;
} {
  let removedCount = 0;

  const filtered = jobs.filter((job) => {
    // Only apply filter to the specific feed
    if (job.sourceUrl !== EUROPE_CANADA_ONLY_FEED) {
      return true; // Allow all jobs from other feeds
    }

    // Use LocationExtractor to extract country (handles cities, states, and direct country matches)
    const locationData = LocationExtractor.extractLocation(
      job.location || "",
      job.link,
      job.title,
      job.description,
    );

    // Allow if country is in the allowed list
    if (locationData.country && ALLOWED_COUNTRIES.has(locationData.country)) {
      return true;
    }

    removedCount++;
    logger.info(
      `Filtering out job from ${EUROPE_CANADA_ONLY_FEED}: ${job.title} (location: ${job.location || "unknown"}, detected country: ${locationData.country || "unknown"}, city: ${locationData.city || "unknown"})`,
    );
    return false;
  });

  return { filtered, removedCount };
}

/**
 * Deduplicate jobs based on URL
 * A job is considered duplicate if its URL matches an already seen job
 * Only URLs containing "http" are considered valid
 */
function deduplicateJobs(jobs: JobItem[]): JobItem[] {
  const seenUrls = new Set<string>();
  const uniqueJobs: JobItem[] = [];

  for (const job of jobs) {
    const normalizedUrl = job.link.toLowerCase().trim();

    // Skip jobs with invalid URLs (must contain http)
    if (!normalizedUrl.includes("http")) {
      logger.warn(
        `Skipping job with invalid URL: "${job.link}" - ${job.title}`,
      );
      continue;
    }

    // Skip if URL has been seen before
    if (!seenUrls.has(normalizedUrl)) {
      seenUrls.add(normalizedUrl);
      uniqueJobs.push(job);
    }
  }

  return uniqueJobs;
}

/**
 * Main service for checking RSS feeds and sending job notifications
 */
export async function checkAndSendJobs(): Promise<CronJobResult> {
  logger.info("Starting job check...");

  try {
    // Log cache stats at the start
    const cacheStats = dailyJobCache.getStats();
    logger.info(
      `Daily cache stats: ${cacheStats.sentCount} jobs sent today (${cacheStats.date})`,
    );

    // Parse all RSS feeds
    const allJobs = await parseRSSFeeds(RSS_FEED_URLS);
    logger.info(
      `Fetched ${allJobs.length} total jobs from ${RSS_FEED_URLS.length} feeds`,
    );

    // Extract all publication dates from found jobs
    const pubDates = allJobs.map((job) => job.pubDate);

    // Deduplicate jobs based on title
    const uniqueJobs = deduplicateJobs(allJobs);
    logger.info(
      `After deduplication: ${uniqueJobs.length} unique jobs (removed ${allJobs.length - uniqueJobs.length} duplicates)`,
    );

    // Filter jobs by feed-specific location rules (Europe/Canada only for specific feed)
    const {
      filtered: locationFilteredJobs,
      removedCount: locationFilteredCount,
    } = filterJobsByFeedLocation(uniqueJobs);
    logger.info(
      `After location filter: ${locationFilteredJobs.length} jobs (removed ${locationFilteredCount} non-Europe/Canada jobs from filtered feed)`,
    );

    // Filter for recent jobs
    const recentJobs = filterRecentJobs(
      locationFilteredJobs,
      CHECK_INTERVAL_MINUTES,
    );
    logger.info(
      `Found ${recentJobs.length} recent jobs (within ${CHECK_INTERVAL_MINUTES} minutes)`,
    );

    // Load persistent cache and filter out already cached jobs
    const urlCache = new UrlCache("url-rss");
    await urlCache.load();

    logger.info(`\n=== Cache Check Before Sending to Telegram ===`);
    logger.info(`Recent jobs to check: ${recentJobs.length}`);
    logger.info(`URLs already in cache: ${urlCache.size()}`);

    // Filter out jobs that have already been sent (using persistent cache)
    const newJobs = recentJobs.filter((job) => {
      const normalizedUrl = job.link.toLowerCase().trim();
      if (urlCache.has(normalizedUrl)) {
        logger.info(`✗ Filtering out cached job: ${normalizedUrl}`);
        return false;
      }
      return true;
    });

    logger.info(
      `Jobs after cache filter: ${newJobs.length} (filtered out ${recentJobs.length - newJobs.length} already cached)`,
    );

    // If no new jobs, return early
    if (newJobs.length === 0) {
      logger.info("No new jobs to send - all already cached");
      return {
        total: allJobs.length,
        sent: 0,
        failed: 0,
        pubDates,
        locationFiltered: locationFilteredCount,
      };
    }

    // Format messages and pre-compute GOAT eligibility for each job
    const jobMessages = newJobs.map((job) => ({
      message: formatJobMessage(job),
      isGoat: isGoatEligible(job),
    }));
    const messages = jobMessages.map((jm) => jm.message);

    // Send messages with rate limiting to main channel
    const { sent, failed } = await sendMessagesWithRateLimit(
      messages,
      RATE_LIMIT_DELAY_MS,
    );

    // CRITICAL: Only mark SUCCESSFULLY sent jobs in the persistent cache
    // Failed jobs should NOT be cached so they can be retried
    if (sent > 0) {
      const sentJobs = newJobs.slice(0, sent);
      for (const job of sentJobs) {
        const normalizedUrl = job.link.toLowerCase().trim();
        // Use pubDate as the timestamp for 48-hour expiry calculation
        // This ensures URLs expire based on when the job was posted, not when we cached it
        urlCache.add(normalizedUrl, job.pubDate);
        logger.info(
          `✓ Added to cache after successful send: ${normalizedUrl} (pubDate: ${job.pubDate})`,
        );
      }
      await urlCache.save();
      logger.info(`Cache saved with ${urlCache.size()} total URLs`);
    }

    // Log failed jobs for debugging
    if (failed > 0) {
      logger.warn(
        `${failed} jobs failed to send and will be retried in next run`,
      );
    }

    // GOAT channel: send qualifying jobs from the successfully sent batch
    if (sent > 0 && GOAT_TELEGRAM_BOT_TOKEN && GOAT_TELEGRAM_CHAT_ID) {
      const goatMessages = jobMessages
        .slice(0, sent)
        .filter((jm) => jm.isGoat)
        .map((jm) => jm.message);

      if (goatMessages.length > 0) {
        logger.info(`Sending ${goatMessages.length} GOAT-eligible jobs to GOAT channel`);
        const goatResult = await sendMessagesWithRateLimitTo(
          GOAT_TELEGRAM_BOT_TOKEN,
          GOAT_TELEGRAM_CHAT_ID,
          goatMessages,
          RATE_LIMIT_DELAY_MS,
        );
        logger.info(`GOAT channel: ${goatResult.sent} sent, ${goatResult.failed} failed`);
      } else {
        logger.info(`No GOAT-eligible jobs in this batch`);
      }
    }

    logger.info(`Job check completed: ${sent} sent, ${failed} failed`);

    return {
      total: allJobs.length,
      sent,
      failed,
      pubDates,
      locationFiltered: locationFilteredCount,
    };
  } catch (error) {
    logger.error("Error in checkAndSendJobs:", error);
    throw error;
  }
}
