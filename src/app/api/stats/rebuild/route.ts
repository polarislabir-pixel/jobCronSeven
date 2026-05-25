import { NextRequest, NextResponse } from "next/server";
import { getR2Storage } from "@/lib/r2-storage";
import {
  JobMetadata,
  MonthlyStatistics,
  getJobStatisticsCacheR2,
} from "@/lib/job-statistics-r2";
import { writeAggregateJson } from "@/lib/job-statistics-parquet";
import { normalizeCity } from "@/lib/location-extractor";
import { logger } from "@/lib/logger";

/**
 * Normalize URL for consistent deduplication
 */
function normalizeUrl(url: string): string {
  return url.toLowerCase().trim();
}

/** Numeric midpoint of a salary range, 0 if neither end is known. */
function salaryMidpoint(salary: { min: number | null; max: number | null }): number {
  if (salary.min !== null && salary.max !== null) return (salary.min + salary.max) / 2;
  return salary.min ?? salary.max ?? 0;
}

type SalaryStats = NonNullable<MonthlyStatistics["salaryStats"]>;
type SalaryRangeKey = keyof SalaryStats["salaryRanges"];

/** Bucket label for the 6 salary-range histogram entries. */
function salaryBucket(midpoint: number): SalaryRangeKey {
  if (midpoint < 30_000) return '0-30k';
  if (midpoint < 50_000) return '30-50k';
  if (midpoint < 75_000) return '50-75k';
  if (midpoint < 100_000) return '75-100k';
  if (midpoint < 150_000) return '100-150k';
  return '150k+';
}

function emptySalaryStats(): SalaryStats {
  return {
    totalWithSalary: 0,
    averageSalary: null,
    medianSalary: null,
    byIndustry: {},
    bySeniority: {},
    byLocation: {},
    byCountry: {},
    byCity: {},
    byCurrency: {},
    salaryRanges: {
      '0-30k': 0,
      '30-50k': 0,
      '50-75k': 0,
      '75-100k': 0,
      '100-150k': 0,
      '150k+': 0,
    },
  };
}

/** Median of a sorted numeric array. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : Math.round(sorted[mid]);
}

export const maxDuration = 300; // 5 minutes timeout
export const dynamic = "force-dynamic";

/**
 * POST /api/stats/rebuild
 *
 * Rebuilds the URL index and recalculates statistics from actual job data in R2.
 * This fixes duplicate job issues by:
 * 1. Loading all metadata files
 * 2. Deduplicating by URL
 * 3. Rebuilding the URL index
 * 4. Recalculating statistics
 * 5. Rewriting deduplicated data
 */
export async function POST(request: NextRequest) {
  logger.info("=== Starting R2 Data Rebuild ===");

  try {
    const r2 = getR2Storage();

    if (!r2.isAvailable()) {
      return NextResponse.json(
        { error: "R2 not configured" },
        { status: 400 }
      );
    }

    // Load manifest
    const manifest = await r2.getManifest();
    logger.info(`Loaded manifest with ${manifest.availableMonths.length} months`);

    // Collect all jobs from all months, deduplicating by URL
    const allJobsByUrl = new Map<string, { metadata: JobMetadata; month: string; day: string }>();
    let totalLoaded = 0;
    let duplicatesFound = 0;

    for (const month of manifest.availableMonths) {
      const monthData = manifest.months[month];
      if (!monthData?.days) continue;

      for (const day of monthData.days) {
        try {
          const metadata = await r2.getNDJSONGzipped<JobMetadata>(day.metadata);
          totalLoaded += metadata.length;

          for (const job of metadata) {
            const normalizedUrl = normalizeUrl(job.url);
            if (allJobsByUrl.has(normalizedUrl)) {
              duplicatesFound++;
            } else {
              allJobsByUrl.set(normalizedUrl, {
                metadata: job,
                month,
                day: day.date,
              });
            }
          }

          logger.info(`Processed ${day.date}: ${metadata.length} jobs`);
        } catch (error) {
          logger.error(`Error loading ${day.metadata}:`, error);
        }
      }
    }

    logger.info(`Total loaded: ${totalLoaded}, Unique: ${allJobsByUrl.size}, Duplicates: ${duplicatesFound}`);

    // Build URL index
    const urlIndex = Array.from(allJobsByUrl.keys());

    // Save URL index
    await r2.putJSON('url-index.json', {
      urls: urlIndex,
      updatedAt: new Date().toISOString(),
      count: urlIndex.length,
    }, 'public, max-age=60');

    logger.info(`✓ Saved URL index with ${urlIndex.length} URLs`);

    // Recalculate statistics for each month, preserving every field the
    // dashboard reads (salaryStats, byRoleType/Category, byHour/DayHour).
    // The previous version of this route silently dropped those, so running
    // it wiped the salary widgets, role chips, and posting heatmap.
    const statsByMonth = new Map<string, MonthlyStatistics>();

    // Per-month buckets of raw salary midpoints, kept separately so we can
    // compute median + per-group avg/median once at the end. The flat
    // updateSalaryStats path doesn't keep medians (it can't — needs full set),
    // so a rebuild is the only opportunity to recompute them correctly.
    const salaryBuckets = new Map<string, {
      all: number[];
      byIndustry: Record<string, number[]>;
      bySeniority: Record<string, number[]>;
      byLocation: Record<string, number[]>;
      byCountry: Record<string, number[]>;
      byCity: Record<string, number[]>;
    }>();

    const emptyStats = (): MonthlyStatistics => ({
      totalJobs: 0,
      byDate: {},
      byIndustry: {},
      byCertificate: {},
      byKeyword: {},
      bySeniority: {},
      byLocation: {},
      byCountry: {},
      byCity: {},
      byRegion: {},
      byCompany: {},
      bySoftware: {},
      byProgrammingSkill: {},
      byYearsExperience: {},
      byAcademicDegree: {},
      byRoleType: {},
      byRoleCategory: {},
      byHour: {},
      byDayHour: {},
      salaryStats: emptySalaryStats(),
    });

    for (const month of manifest.availableMonths) {
      statsByMonth.set(month, emptyStats());
      salaryBuckets.set(month, {
        all: [],
        byIndustry: {},
        bySeniority: {},
        byLocation: {},
        byCountry: {},
        byCity: {},
      });
    }

    // Calculate stats from unique jobs
    for (const { metadata, month } of allJobsByUrl.values()) {
      const stats = statsByMonth.get(month);
      const salaries = salaryBuckets.get(month);
      if (!stats || !salaries) continue;

      stats.totalJobs++;

      const dateKey = metadata.extractedDate.split('T')[0];
      stats.byDate[dateKey] = (stats.byDate[dateKey] || 0) + 1;

      if (metadata.industry) {
        stats.byIndustry[metadata.industry] = (stats.byIndustry[metadata.industry] || 0) + 1;
      }

      metadata.certificates?.forEach(cert => {
        stats.byCertificate[cert] = (stats.byCertificate[cert] || 0) + 1;
      });

      metadata.keywords?.forEach(keyword => {
        stats.byKeyword[keyword] = (stats.byKeyword[keyword] || 0) + 1;
      });

      if (metadata.seniority) {
        stats.bySeniority[metadata.seniority] = (stats.bySeniority[metadata.seniority] || 0) + 1;
      }

      if (metadata.location) {
        stats.byLocation[metadata.location] = (stats.byLocation[metadata.location] || 0) + 1;
      }

      if (metadata.country) {
        stats.byCountry[metadata.country] = (stats.byCountry[metadata.country] || 0) + 1;
      }

      // Match what JobStatisticsCacheR2.updateStatistics does — normalize
      // city names so "Greater London Area" and "London" collapse together.
      const normalizedCityName = normalizeCity(metadata.city);
      if (normalizedCityName) {
        stats.byCity[normalizedCityName] = (stats.byCity[normalizedCityName] || 0) + 1;
      }

      if (metadata.region) {
        stats.byRegion[metadata.region] = (stats.byRegion[metadata.region] || 0) + 1;
      }

      if (metadata.company) {
        stats.byCompany[metadata.company] = (stats.byCompany[metadata.company] || 0) + 1;
      }

      metadata.software?.forEach(soft => {
        stats.bySoftware[soft] = (stats.bySoftware[soft] || 0) + 1;
      });

      metadata.programmingSkills?.forEach(skill => {
        stats.byProgrammingSkill[skill] = (stats.byProgrammingSkill[skill] || 0) + 1;
      });

      if (metadata.yearsExperience) {
        stats.byYearsExperience[metadata.yearsExperience] = (stats.byYearsExperience[metadata.yearsExperience] || 0) + 1;
      }

      metadata.academicDegrees?.forEach(degree => {
        stats.byAcademicDegree[degree] = (stats.byAcademicDegree[degree] || 0) + 1;
      });

      // Role categorization (dashboard chips + treemap).
      if (metadata.roleType) {
        stats.byRoleType![metadata.roleType] = (stats.byRoleType![metadata.roleType] || 0) + 1;
      }
      if (metadata.roleCategory) {
        stats.byRoleCategory![metadata.roleCategory] = (stats.byRoleCategory![metadata.roleCategory] || 0) + 1;
      }

      // Publication-time data (heatmap + hour-of-day bar). Uses postedDate
      // in UTC, matching JobStatisticsCacheR2.updateStatistics.
      if (metadata.postedDate) {
        const posted = new Date(metadata.postedDate);
        if (!Number.isNaN(posted.getTime())) {
          const hour = posted.getUTCHours();
          const hourKey = String(hour).padStart(2, '0');
          stats.byHour![hourKey] = (stats.byHour![hourKey] || 0) + 1;
          const dayHourKey = `${posted.getUTCDay()}-${hour}`;
          stats.byDayHour![dayHourKey] = (stats.byDayHour![dayHourKey] || 0) + 1;
        }
      }

      // Salary — collect raw midpoints per group for median computation at
      // the end. Also increment the flat range/currency counters now.
      if (metadata.salary) {
        const midpoint = salaryMidpoint(metadata.salary);
        if (midpoint > 0) {
          stats.salaryStats!.totalWithSalary++;
          stats.salaryStats!.byCurrency[metadata.salary.currency] =
            (stats.salaryStats!.byCurrency[metadata.salary.currency] || 0) + 1;
          stats.salaryStats!.salaryRanges[salaryBucket(midpoint)]++;

          salaries.all.push(midpoint);
          if (metadata.industry) (salaries.byIndustry[metadata.industry] ||= []).push(midpoint);
          if (metadata.seniority) (salaries.bySeniority[metadata.seniority] ||= []).push(midpoint);
          if (metadata.location) (salaries.byLocation[metadata.location] ||= []).push(midpoint);
          if (metadata.country) (salaries.byCountry[metadata.country] ||= []).push(midpoint);
          if (normalizedCityName) (salaries.byCity[normalizedCityName] ||= []).push(midpoint);
        }
      }
    }

    // Finalize salary stats — compute averageSalary, medianSalary, and the
    // per-group {avg, median, count} entries from the raw midpoint buckets.
    for (const [month, stats] of statsByMonth.entries()) {
      const buckets = salaryBuckets.get(month);
      if (!buckets || buckets.all.length === 0) continue;

      const sortedAll = [...buckets.all].sort((a, b) => a - b);
      stats.salaryStats!.averageSalary = Math.round(
        sortedAll.reduce((s, v) => s + v, 0) / sortedAll.length,
      );
      stats.salaryStats!.medianSalary = median(sortedAll);

      const summarize = (groups: Record<string, number[]>) =>
        Object.entries(groups).reduce<Record<string, { avg: number; median: number; count: number }>>(
          (acc, [key, vals]) => {
            if (vals.length > 0) {
              const sorted = [...vals].sort((a, b) => a - b);
              acc[key] = {
                avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
                median: median(sorted),
                count: vals.length,
              };
            }
            return acc;
          },
          {},
        );

      stats.salaryStats!.byIndustry = summarize(buckets.byIndustry);
      stats.salaryStats!.bySeniority = summarize(buckets.bySeniority);
      stats.salaryStats!.byLocation = summarize(buckets.byLocation);
      stats.salaryStats!.byCountry = summarize(buckets.byCountry);
      stats.salaryStats!.byCity = summarize(buckets.byCity);
    }

    // Save updated stats for each month
    let totalJobsAllTime = 0;
    for (const [month, stats] of statsByMonth.entries()) {
      await r2.putJSON(`stats/${month}.json`, stats, 'public, max-age=60');
      totalJobsAllTime += stats.totalJobs;
      logger.info(`✓ Saved stats for ${month}: ${stats.totalJobs} unique jobs`);

      // Update manifest month totals
      if (manifest.months[month]) {
        manifest.months[month].totalJobs = stats.totalJobs;
      }
    }

    // Update manifest totals
    manifest.totalJobsAllTime = totalJobsAllTime;
    await r2.saveManifest(manifest);

    // Refresh the two derived files. Without this step, the dashboard's
    // diagnostic widget keeps flagging a mismatch — the per-month stats files
    // were just corrected, but aggregated-stats.json and stats/aggregate.json
    // still hold the stale (pre-rebuild) totals until the next cron save().
    //
    // The legacy aggregated-stats.json is deleted so the next read forces a
    // recompute. stats/aggregate.json is written here directly with the
    // freshly-rebuilt data so the dashboard converges on next reload.
    let aggregateRefreshed = false;
    try {
      await r2.delete('aggregated-stats.json').catch(() => {});

      const cache = getJobStatisticsCacheR2();
      await cache.load(); // re-reads the rebuilt manifest + stats files
      const aggResult = await cache.getAllArchivesAggregated();

      const refreshedManifest = cache.getManifest();
      if (refreshedManifest) {
        await writeAggregateJson({
          manifest: refreshedManifest,
          currentMonthStats: cache.getCurrentStatistics(),
          archives: aggResult.archives,
          aggregatedStats: aggResult.aggregated,
          totalJobs: aggResult.totalJobs,
        });
        aggregateRefreshed = true;
      }
    } catch (err) {
      logger.error("Rebuild: aggregate refresh step failed (per-month stats still saved):", err);
    }

    logger.info("=== Rebuild Complete ===");

    return NextResponse.json({
      success: true,
      message: "Rebuild completed successfully",
      stats: {
        totalLoaded,
        uniqueJobs: allJobsByUrl.size,
        duplicatesRemoved: duplicatesFound,
        urlIndexSize: urlIndex.length,
        totalJobsAllTime,
        monthsProcessed: manifest.availableMonths.length,
        aggregateRefreshed,
      },
    });
  } catch (error) {
    logger.error("Rebuild failed:", error);

    return NextResponse.json(
      {
        error: "Rebuild failed",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * GET endpoint - returns rebuild status/info
 */
export async function GET() {
  const r2 = getR2Storage();

  if (!r2.isAvailable()) {
    return NextResponse.json({ error: "R2 not configured" }, { status: 400 });
  }

  const urlIndex = await r2.getJSON<{ urls: string[]; updatedAt: string; count: number }>('url-index.json');
  const manifest = await r2.getManifest();

  return NextResponse.json({
    status: "ready",
    message: "POST to this endpoint to rebuild URL index and recalculate statistics",
    currentState: {
      urlIndexExists: !!urlIndex,
      urlIndexCount: urlIndex?.count || 0,
      urlIndexUpdatedAt: urlIndex?.updatedAt || null,
      manifestTotalJobs: manifest.totalJobsAllTime,
      availableMonths: manifest.availableMonths,
    },
    warning: "This will recalculate all statistics from raw job data. May take several minutes.",
  });
}
