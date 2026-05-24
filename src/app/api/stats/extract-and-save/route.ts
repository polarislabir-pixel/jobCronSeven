import { NextRequest, NextResponse } from "next/server";
import { parseRSSFeeds } from "@/lib/rss-parser";
import { getStatsCache, getStorageInfo } from "@/lib/stats-storage";
import { JobStatistic } from "@/lib/job-statistics-cache";
import { JobMetadataExtractor } from "@/lib/job-metadata-extractor";
import { SalaryExtractor } from "@/lib/salary-extractor";
import { LocationExtractor } from "@/lib/location-extractor";
import { extractJobDetails } from "@/lib/job-analyzer";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { getCompanyFromUrl, getCountryFromUrlTLD, resolvePostedDate } from "@/lib/company-location-lookup";

// Get RSS Stats Feed URLs from environment (separate from RSS monitor)
const RSS_STATS_FEED_URLS = process.env.RSS_STATS_FEED_URLS
  ? process.env.RSS_STATS_FEED_URLS.split(',').map((url) => url.trim())
  : [];

export const maxDuration = 300; // 5 minutes timeout
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/extract-and-save
 *
 * Extracts job data from RSS feeds, analyzes metadata, and saves to GitHub Gist
 * This endpoint can be called manually or via cron
 */
export async function GET(request: NextRequest) {
  logger.info("Statistics extraction started");

  try {
    // Validate environment variables
    validateEnvironmentVariables();

    // Initialize statistics cache (auto-selects R2 or Gist based on config)
    const statsCache = await getStatsCache();
    await statsCache.load();

    const storageInfo = getStorageInfo();

    logger.info(`Loaded statistics cache: ${statsCache.getStats().currentMonthJobs} jobs in current month`);

    // Parse all RSS feeds
    logger.info(`Parsing ${RSS_STATS_FEED_URLS.length} RSS feeds...`);
    const allJobs = await parseRSSFeeds(RSS_STATS_FEED_URLS);
    logger.info(`Fetched ${allJobs.length} total jobs from RSS feeds`);

    if (allJobs.length === 0) {
      logger.info("No jobs found in RSS feeds");
      return NextResponse.json({
        success: true,
        message: "No jobs found in RSS feeds",
        processed: 0,
        newJobs: 0,
      });
    }

    // Process each job and extract metadata
    let processedCount = 0;
    let newJobsCount = 0;
    let skippedKnown = 0;

    for (const rssJob of allJobs) {
      try {
        // Skip if URL is invalid
        if (!rssJob.link || !rssJob.link.includes('http')) {
          logger.warn(`Skipping job with invalid URL: ${rssJob.title}`);
          continue;
        }

        // Dedup-first: skip the heavy extractor pipeline for already-known URLs.
        // addJob would reject them anyway; this just saves the wasted CPU.
        if (statsCache.isKnownUrl?.(rssJob.link)) {
          skippedKnown++;
          processedCount++;
          continue;
        }

        // Step 1: Extract company, position, and location using job-analyzer method first
        const jobDetails = extractJobDetails(rssJob.title);

        // Step 2: Use job-analyzer results with fallback to RSS data
        let finalCompany = jobDetails.company !== 'N/A' ? jobDetails.company : (rssJob.company || 'Unknown Company');
        let finalPosition = jobDetails.position;
        let extractedLocation = jobDetails.location !== 'N/A' ? jobDetails.location : null;
        // Strip soft hyphens, HTML entities, URL-encoded noise, and zero-width chars
        finalCompany = finalCompany
          .replace(/%C2%AD|%C2%A0|%E2%80%8B|%E2%80%8C|%E2%80%8D/g, '') // URL-encoded soft hyphen, NBSP, zero-width
          .replace(/&shy;|&nbsp;|&amp;|&apos;|&quot;|&#173;|&#160;|&#8203;/g, (m) => m === '&amp;' ? '&' : m === '&apos;' ? "'" : m === '&quot;' ? '"' : '') // HTML entities
          .replace(/[­​‌‍﻿]/g, '') // unicode soft hyphen, zero-width chars, BOM
          .trim();
        // Step 2b: If company is still unknown, match against KNOWN_COMPANIES using the URL only
        if (finalCompany === 'Unknown Company' || finalCompany === 'N/A'|| finalCompany.trim() === '') {
          const matched = getCompanyFromUrl(rssJob.link, rssJob.title);
          if (matched) finalCompany = matched;
        }

        // Step 3: Extract location properly - try job-analyzer result first, then LocationExtractor
        let locationData = { country: null as string | null, city: null as string | null, region: null as 'Europe' | 'America' | 'Middle East' | 'Asia' | 'Africa' | 'Oceania' | null };

        // First, try location from job-analyzer if available
        if (extractedLocation) {
          locationData = LocationExtractor.extractLocation(
            extractedLocation,
            rssJob.link,
            null,
            ''
          );
        }

        // If location is still not found, fall back to current logic
        if (!locationData.country && !locationData.city) {
          locationData = LocationExtractor.extractLocation(
            rssJob.title,
            rssJob.link,
            rssJob.location,
            rssJob.description || ''
          );
        }

        // URL TLD fallback — e.g. jobs.hsbc.co.uk → United Kingdom
        if (!locationData.country && !locationData.city) {
          const tldCountry = getCountryFromUrlTLD(rssJob.link);
          if (tldCountry) {
            locationData = { ...locationData, country: tldCountry };
          }
        }

        // Format location for display
        const formattedLocation = extractedLocation || LocationExtractor.formatLocation(locationData) || locationData.country || '';

        // Extract metadata using the final company name
        const metadata = JobMetadataExtractor.extractAllMetadata({
          title: finalPosition,
          company: finalCompany,
          description: rssJob.description || '',
          url: rssJob.link,
        });

        // Extract salary information and normalize to annual
        let salary = SalaryExtractor.extractSalary(
          rssJob.title,
          rssJob.description || ''
        );

        // Normalize to annual values to ensure consistency
        if (salary) {
          salary = SalaryExtractor.normalizeToAnnual(salary);
        }

        // For Indeed jobs, rewrite the tracking param so the direct link works
        let jobUrl = rssJob.link.toLowerCase().includes('indeed')
          ? rssJob.link.replace('from=social_other', 'from=jobsearch-empty-whatwhere')
          : rssJob.link;

        // Strip HTML-encoded ampersands from Indeed URLs
        if (jobUrl.toLowerCase().includes('indeed')) {
          jobUrl = jobUrl.replace(/amp;/g, '');
        }

        // Create job statistic object
        const jobStat: JobStatistic = {
          id: metadata.id,
          title: rssJob.title,
          company: finalCompany,
          location: rssJob.location || formattedLocation,
          country: locationData.country,
          city: locationData.city,
          region: locationData.region,
          url: jobUrl,
          postedDate: resolvePostedDate(rssJob.pubDate),
          extractedDate: new Date().toISOString(),
          keywords: metadata.keywords,
          certificates: metadata.certificates,
          industry: metadata.industry,
          seniority: metadata.seniority,
          description: rssJob.description || '',
          salary: salary,
        };

        // Add to cache (will skip if already exists)
        const beforeCount = statsCache.getCurrentStatistics().totalJobs;
        statsCache.addJob(jobStat);
        const afterCount = statsCache.getCurrentStatistics().totalJobs;

        if (afterCount > beforeCount) {
          newJobsCount++;
        }

        processedCount++;
      } catch (error) {
        logger.error(`Error processing job: ${rssJob.title}`, error);
        // Continue with next job
      }
    }

    // Save to storage (R2 or Gist)
    if (newJobsCount > 0) {
      logger.info(`Saving ${newJobsCount} new jobs to ${storageInfo.backend.toUpperCase()}...`);
      await statsCache.save();
      logger.info(`✓ Successfully saved statistics to ${storageInfo.backend.toUpperCase()}`);
    } else {
      // Log diagnostic info about why all jobs are duplicates
      const urlIndexSize = statsCache.getUrlIndexSize?.() || 'unknown';
      logger.info(`No new jobs to save (all ${processedCount} jobs already exist)`);
      logger.info(`  → URL index contains ${urlIndexSize} URLs. All ${processedCount} incoming RSS URLs matched.`);
      logger.info(`  → This means RSS feed has no NEW postings. Run POST /api/stats/rebuild to reset.`);
    }

    // Get final statistics
    const finalStats = statsCache.getStats();
    const currentStats = statsCache.getCurrentStatistics();

    logger.info("Statistics extraction completed successfully");

    return NextResponse.json({
      success: true,
      message: `Processed ${processedCount} jobs, added ${newJobsCount} new jobs`,
      processed: processedCount,
      newJobs: newJobsCount,
      currentMonth: finalStats.currentMonth,
      currentMonthTotal: finalStats.currentMonthJobs,
      totalAllTime: finalStats.totalJobsAllTime,
      storageBackend: storageInfo.backend,
      statistics: {
        byIndustry: currentStats.byIndustry,
        byCertificate: currentStats.byCertificate,
        bySeniority: currentStats.bySeniority,
        topKeywords: Object.entries(currentStats.byKeyword)
          .sort(([, a], [, b]) => (b as number) - (a as number))
          .slice(0, 10)
          .reduce((acc, [key, value]) => {
            acc[key] = value as number;
            return acc;
          }, {} as Record<string, number>),
      },
    });
  } catch (error) {
    logger.error("Error during statistics extraction:", error);

    return NextResponse.json(
      {
        error: "Failed to extract and save statistics",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * POST endpoint for manual triggering (same as GET)
 */
export async function POST(request: NextRequest) {
  return GET(request);
}
