import { NextRequest, NextResponse } from "next/server";
import { getStatsCache, getStorageInfo } from "@/lib/stats-storage";
import { JobStatistic } from "@/lib/job-statistics-cache";
import { validateEnvironmentVariables } from "@/lib/validation";
import { logger } from "@/lib/logger";
import { parseRSSFeeds } from "@/lib/rss-parser";
import { JobMetadataExtractor } from "@/lib/job-metadata-extractor";
import { SalaryExtractor } from "@/lib/salary-extractor";
import { LocationExtractor } from "@/lib/location-extractor";
import { extractJobDetails, analyzeJobDescription } from "@/lib/job-analyzer";
import { softwareKeywords } from "@/lib/dictionaries/software";
import { programmingKeywords } from "@/lib/dictionaries/programming-languages";
import { RoleTypeExtractor } from "@/lib/role-type-extractor";

// Get RSS Stats Feed URLs from environment (separate from RSS monitor)
const RSS_STATS_FEED_URLS = process.env.RSS_STATS_FEED_URLS
  ? process.env.RSS_STATS_FEED_URLS.split(',').map((url) => url.trim())
  : [];

export const maxDuration = 300; // 5 minutes timeout
export const dynamic = "force-dynamic";

/**
 * GET /api/stats/get
 *
 * Extracts new job data from RSS feeds, updates GitHub Gist, then returns summary statistics
 * This replaces the old behavior of just fetching from gist
 */
export async function GET(request: NextRequest) {
  try {
    // Validate environment variables
    validateEnvironmentVariables();

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const archive = searchParams.get("archive"); // Optional: specific month (YYYY-MM)

    // Initialize statistics cache (auto-selects R2 or Gist based on config)
    const statsCache = await getStatsCache();
    await statsCache.load();

    const storageInfo = getStorageInfo();

    // If requesting archived month, skip extraction and just return archived data
    if (archive) {
      logger.info(`Fetching archived month: ${archive}`);
      const archivedData = await statsCache.getArchivedMonth(archive);

      if (!archivedData) {
        return NextResponse.json(
          {
            error: "Archive not found",
            message: `No archived data found for ${archive}`,
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        type: "archive",
        month: archive,
        data: archivedData,
      });
    }

    // Extract and save new job data from RSS feeds
    logger.info(`Parsing ${RSS_STATS_FEED_URLS.length} RSS feeds...`);
    logger.info(`  RSS Feed URLs: ${RSS_STATS_FEED_URLS.map(u => u.substring(0, 50) + '...').join(', ')}`);
    const allJobs = await parseRSSFeeds(RSS_STATS_FEED_URLS);
    logger.info(`Fetched ${allJobs.length} total jobs from RSS feeds`);

    // Log first 3 RSS job URLs for debugging
    if (allJobs.length > 0) {
      logger.info(`  Sample RSS job URLs:`);
      allJobs.slice(0, 3).forEach((job, i) => {
        logger.info(`    [${i + 1}] ${job.link}`);
        logger.info(`        Title: ${job.title?.substring(0, 50)}...`);
        logger.info(`        PubDate: ${job.pubDate}`);
      });
    }

    let newJobsCount = 0;
    let processedCount = 0;

    if (allJobs.length > 0) {
      // Process each job and extract metadata
      let skippedKnown = 0;
      for (const rssJob of allJobs) {
        try {
          // Skip if URL is invalid
          if (!rssJob.link || !rssJob.link.includes('http')) {
            logger.warn(`Skipping job with invalid URL: ${rssJob.title}`);
            continue;
          }

          // Short-circuit: if the URL is already in the dedup index, skip the
          // entire heavy extractor pipeline (job-analyzer, metadata, salary,
          // location, software, programming, role-type — all regex-heavy).
          // `addJob` would reject it anyway; this just avoids the wasted CPU.
          // On a typical tick 95%+ of RSS items are known URLs.
          if (statsCache.isKnownUrl?.(rssJob.link)) {
            skippedKnown++;
            processedCount++;
            continue;
          }

          // Extract job details
          const jobDetails = extractJobDetails(rssJob.title);

          let finalCompany = jobDetails.company !== 'N/A' ? jobDetails.company : (rssJob.company || 'Unknown Company');
          let finalPosition = jobDetails.position;
          let extractedLocation = jobDetails.location !== 'N/A' ? jobDetails.location : null;

          // Extract location
          let locationData = { country: null as string | null, city: null as string | null, region: null as 'Europe' | 'America' | 'Middle East' | 'Asia' | 'Africa' | 'Oceania' | null };

          if (extractedLocation) {
            locationData = LocationExtractor.extractLocation(
              extractedLocation,
              rssJob.link,
              null,
              ''
            );
          }

          if (!locationData.country && !locationData.city) {
            locationData = LocationExtractor.extractLocation(
              rssJob.title,
              rssJob.link,
              rssJob.location,
              rssJob.description || ''
            );
          }

          const formattedLocation = extractedLocation || LocationExtractor.formatLocation(locationData);

          // Extract metadata
          const metadata = JobMetadataExtractor.extractAllMetadata({
            title: finalPosition,
            company: finalCompany,
            description: rssJob.description || '',
            url: rssJob.link,
          });

          // Extract salary and normalize to annual
          let salary = SalaryExtractor.extractSalary(
            rssJob.title,
            rssJob.description || ''
          );

          // Normalize to annual values to ensure consistency
          if (salary) {
            salary = SalaryExtractor.normalizeToAnnual(salary);
          }

          // Extract software
          const software: string[] = [];
          const description = rssJob.description || '';
          for (const [soft, pattern] of Object.entries(softwareKeywords)) {
            if (pattern.test(description)) {
              software.push(soft);
            }
          }

          // Extract programming skills
          const programmingSkills: string[] = [];
          for (const [skill, pattern] of Object.entries(programmingKeywords)) {
            if (pattern.test(description)) {
              programmingSkills.push(skill);
            }
          }

          // Extract years of experience and academic degrees using job analyzer
          const analysis = analyzeJobDescription(description);

          // Validate yearsExperience - if it's more than 15 years, set to null
          let validatedYearsExperience: string | null = null;
          if (analysis.yearsExperience) {
            // Extract the numeric value from the years experience string
            const yearsMatch = analysis.yearsExperience.match(/(\d+)/);
            if (yearsMatch) {
              const years = parseInt(yearsMatch[1], 10);
              if (years <= 15) {
                validatedYearsExperience = analysis.yearsExperience;
              }
            }
          }

          // Extract role type and category
          const roleTypeMatch = RoleTypeExtractor.extractRoleType(
            finalPosition,
            metadata.keywords,
            rssJob.description || '',
            metadata.industry
          );

          // Create job statistic object
          const jobStat: JobStatistic = {
            id: metadata.id,
            title: rssJob.title,
            company: finalCompany,
            location: rssJob.location || formattedLocation,
            country: locationData.country,
            city: locationData.city,
            region: locationData.region,
            url: rssJob.link,
            postedDate: rssJob.pubDate,
            extractedDate: new Date().toISOString(),
            keywords: metadata.keywords,
            certificates: metadata.certificates,
            industry: metadata.industry,
            seniority: metadata.seniority,
            description: rssJob.description || '',
            salary: salary,
            software: software.length > 0 ? software : undefined,
            programmingSkills: programmingSkills.length > 0 ? programmingSkills : undefined,
            yearsExperience: validatedYearsExperience,
            academicDegrees: analysis.academicDegrees.length > 0 ? analysis.academicDegrees : undefined,
            roleType: roleTypeMatch?.roleType || null,
            roleCategory: roleTypeMatch?.category || null,
          };

          // Add to cache
          const beforeCount = statsCache.getCurrentStatistics().totalJobs;
          statsCache.addJob(jobStat);
          const afterCount = statsCache.getCurrentStatistics().totalJobs;

          if (afterCount > beforeCount) {
            newJobsCount++;
          }

          processedCount++;
        } catch (error) {
          logger.error(`Error processing job: ${rssJob.title}`, error);
        }
      }

      // Save to storage (R2 or Gist) if there are new jobs
      if (newJobsCount > 0) {
        logger.info(`Saving ${newJobsCount} new jobs to ${storageInfo.backend.toUpperCase()}...`);
        await statsCache.save();
        logger.info(`✓ Successfully saved statistics to ${storageInfo.backend.toUpperCase()}`);
      } else {
        // No new jobs → no save, no aggregate recompute, no response payload
        // rebuild. Cron tick exits with a minimal "no-op" body. This is the
        // dominant case after url-index has warmed up; cutting the work here
        // is the single biggest CPU win per tick.
        const urlIndexSize = statsCache.getUrlIndexSize?.() || 'unknown';
        logger.info(`No new jobs to save (all ${processedCount} jobs already exist, ${skippedKnown} skipped via dedup-first)`);
        logger.info(`  → URL index contains ${urlIndexSize} URLs. All incoming RSS URLs matched the index.`);

        const summary = statsCache.getSummary();
        const stats = statsCache.getStats();
        return NextResponse.json({
          success: true,
          message: `Processed ${processedCount} jobs, added 0 new jobs (short-circuit)`,
          processed: processedCount,
          newJobs: 0,
          skippedKnown,
          summary: {
            totalJobsAllTime: stats.totalJobsAllTime,
            currentMonth: summary.currentMonth,
            currentMonthJobs: stats.currentMonthJobs,
            availableArchives: summary.availableArchives,
            storageBackend: storageInfo.backend,
          },
        });
      }
    }

    // Return summary data only (no full job details)
    const summary = statsCache.getSummary();
    const stats = statsCache.getStats();

    // Get aggregated data from ALL archived months + current month
    logger.info('Loading and aggregating all archived months...');
    const { archives, aggregated, totalJobs } = await statsCache.getAllArchivesAggregated();

    // Helper to get top N entries from an object
    const getTopN = (obj: Record<string, number>, n: number) => {
      return Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .reduce((acc, [key, val]) => ({ ...acc, [key]: val }), {});
    };

    return NextResponse.json({
      success: true,
      message: `Processed ${processedCount} jobs, added ${newJobsCount} new jobs`,
      processed: processedCount,
      newJobs: newJobsCount,
      summary: {
        totalJobsAllTime: totalJobs,
        currentMonth: summary.currentMonth,
        currentMonthJobs: stats.currentMonthJobs,
        monthsIncluded: archives.length + 1,
        availableArchives: summary.availableArchives,
        storageBackend: storageInfo.backend,
      },
      topStats: {
        industries: getTopN(aggregated.byIndustry, 5),
        certificates: getTopN(aggregated.byCertificate, 5),
        keywords: getTopN(aggregated.byKeyword, 5),
        seniority: getTopN(aggregated.bySeniority, 5),
        regions: getTopN(aggregated.byRegion, 5),
        countries: getTopN(aggregated.byCountry, 5),
      },
    });
  } catch (error) {
    logger.error("Error fetching statistics:", error);

    return NextResponse.json(
      {
        error: "Failed to fetch statistics",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
