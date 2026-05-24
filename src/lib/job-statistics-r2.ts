import { logger } from './logger';
import { SalaryData } from './salary-extractor';
import { getR2Storage, Manifest, ManifestDay } from './r2-storage';
import { normalizeCity } from './location-extractor';
import { writeDailyParquet, writeAggregateJson } from './job-statistics-parquet';

/**
 * Normalize URL for consistent deduplication
 * Matches the normalization used in url-cache.ts
 */
function normalizeUrl(url: string): string {
  return url.toLowerCase().trim();
}

// Re-export existing interfaces for compatibility
export interface JobStatistic {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string | null;
  city: string | null;
  region: 'Europe' | 'America' | 'Middle East' | 'Asia' | 'Africa' | 'Oceania' | null;
  url: string;
  postedDate: string;
  extractedDate: string;
  keywords: string[];
  certificates: string[];
  industry: string;
  seniority: string;
  description: string;
  salary?: SalaryData | null;
  software?: string[];
  programmingSkills?: string[];
  yearsExperience?: string | null;
  academicDegrees?: string[];
  roleType?: string | null;
  roleCategory?: string | null;
}

/**
 * Job metadata (lightweight, for filtering)
 * ~300-500 bytes per job
 */
export interface JobMetadata {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string | null;
  city: string | null;
  region: 'Europe' | 'America' | 'Middle East' | 'Asia' | 'Africa' | 'Oceania' | null;
  url: string;
  postedDate: string;
  extractedDate: string;
  keywords: string[];
  certificates: string[];
  industry: string;
  seniority: string;
  salary?: SalaryData | null;
  software?: string[];
  programmingSkills?: string[];
  yearsExperience?: string | null;
  academicDegrees?: string[];
  roleType?: string | null;
  roleCategory?: string | null;
}

/**
 * Job description (heavy content, loaded on-demand)
 * ~2-4KB per job
 */
export interface JobDescription {
  id: string;
  description: string;
}

export interface MonthlyStatistics {
  totalJobs: number;
  byDate: Record<string, number>;
  byIndustry: Record<string, number>;
  byCertificate: Record<string, number>;
  byKeyword: Record<string, number>;
  bySeniority: Record<string, number>;
  byLocation: Record<string, number>;
  byCountry: Record<string, number>;
  byCity: Record<string, number>;
  byRegion: Record<string, number>;
  byCompany: Record<string, number>;
  bySoftware: Record<string, number>;
  byProgrammingSkill: Record<string, number>;
  byYearsExperience: Record<string, number>;
  byAcademicDegree: Record<string, number>;
  byRoleType?: Record<string, number>;
  byRoleCategory?: Record<string, number>;
  byHour?: Record<string, number>;
  byDayHour?: Record<string, number>;
  salaryStats?: {
    totalWithSalary: number;
    averageSalary: number | null;
    medianSalary: number | null;
    byIndustry: Record<string, { avg: number; median: number; count: number }>;
    bySeniority: Record<string, { avg: number; median: number; count: number }>;
    byLocation: Record<string, { avg: number; median: number; count: number }>;
    byCountry: Record<string, { avg: number; median: number; count: number }>;
    byCity: Record<string, { avg: number; median: number; count: number }>;
    byCurrency: Record<string, number>;
    salaryRanges: {
      '0-30k': number;
      '30-50k': number;
      '50-75k': number;
      '75-100k': number;
      '100-150k': number;
      '150k+': number;
    };
  };
}

export interface CurrentMonthData {
  month: string;
  lastUpdated: string;
  jobs: JobStatistic[];
  statistics: MonthlyStatistics;
}

export interface ArchiveMonthData {
  month: string;
  statistics: MonthlyStatistics;
  jobCount: number;
  archived: boolean;
}

export interface SummaryData {
  lastUpdated: string;
  totalJobsAllTime: number;
  currentMonth: string;
  availableArchives: string[];
  overallStatistics: {
    totalMonths: number;
    averageJobsPerMonth: number;
    topIndustries: Record<string, number>;
    topCertificates: Record<string, number>;
    topKeywords: Record<string, number>;
  };
}

/**
 * R2-based Job Statistics Cache
 *
 * File structure in R2:
 * - manifest.json                          (index of all data)
 * - url-index.json                         (set of all job URLs for deduplication)
 * - stats/YYYY-MM.json                     (pre-computed statistics per month)
 * - metadata/YYYY/MM/day-DD.ndjson.gz      (job metadata, ~150KB/day)
 * - descriptions/YYYY/MM/day-DD.ndjson.gz  (job descriptions, ~1.5MB/day)
 */
export class JobStatisticsCacheR2 {
  private r2 = getR2Storage();
  private manifest: Manifest | null = null;
  private pendingJobs: Map<string, JobStatistic[]> = new Map(); // date -> jobs
  private currentMonthStats: MonthlyStatistics | null = null;
  private urlIndex: Set<string> = new Set(); // All known job URLs for deduplication
  private loaded = false;
  private duplicateCount = 0; // Track duplicates per session for debugging

  constructor() {
    logger.info('Job Statistics Cache (R2): Initialized');
  }

  private getCurrentMonthString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  private getDateString(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  /**
   * Rebuild URL index from all stored metadata in R2
   * Called when URL index is out of sync with manifest
   */
  private async rebuildUrlIndexFromMetadata(): Promise<void> {
    this.urlIndex = new Set();

    if (!this.manifest) return;

    for (const month of this.manifest.availableMonths) {
      const monthData = this.manifest.months[month];
      if (!monthData?.days) continue;

      for (const day of monthData.days) {
        try {
          const metadata = await this.r2.getNDJSONGzipped<JobMetadata>(day.metadata);
          for (const job of metadata) {
            this.urlIndex.add(normalizeUrl(job.url));
          }
        } catch (error) {
          logger.warn(`Failed to load metadata for ${day.date}:`, error);
        }
      }
    }

    // Save the rebuilt index
    await this.r2.putJSON('url-index.json', {
      urls: Array.from(this.urlIndex),
      updatedAt: new Date().toISOString(),
      count: this.urlIndex.size,
      rebuiltAt: new Date().toISOString(),
    }, 'public, max-age=60');
  }

  private createEmptyStatistics(): MonthlyStatistics {
    return {
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
      salaryStats: {
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
      },
    };
  }

  /**
   * Load manifest, URL index, and current month stats from R2
   */
  async load(): Promise<void> {
    try {
      if (!this.r2.isAvailable()) {
        logger.warn('R2 not configured, using empty state');
        this.manifest = await this.createEmptyManifest();
        this.currentMonthStats = this.createEmptyStatistics();
        this.urlIndex = new Set();
        this.loaded = true;
        return;
      }

      // Load manifest and URL index in parallel
      const [manifest, urlIndexData] = await Promise.all([
        this.r2.getManifest(),
        this.r2.getJSON<{ urls: string[] }>('url-index.json'),
      ]);

      this.manifest = manifest;
      logger.info(`✓ Loaded manifest: ${this.manifest.totalJobsAllTime} total jobs`);

      // Load URL index for deduplication (normalize URLs for consistent comparison)
      if (urlIndexData?.urls) {
        this.urlIndex = new Set(urlIndexData.urls.map(url => normalizeUrl(url)));
        logger.info(`✓ Loaded URL index: ${this.urlIndex.size} known URLs`);
      } else {
        this.urlIndex = new Set();
        logger.info('No URL index found, will rebuild from metadata');
      }

      // Check if URL index is out of sync with manifest (missing URLs)
      const expectedMinUrls = this.manifest.totalJobsAllTime;
      if (this.urlIndex.size < expectedMinUrls * 0.9) { // Allow 10% tolerance
        logger.warn(`⚠ URL index out of sync! Index has ${this.urlIndex.size} URLs but manifest shows ${expectedMinUrls} jobs`);
        logger.info('Rebuilding URL index from stored metadata...');
        await this.rebuildUrlIndexFromMetadata();
        logger.info(`✓ Rebuilt URL index: ${this.urlIndex.size} URLs`);
      }

      // Reset duplicate counter for this session
      this.duplicateCount = 0;

      // Check for month change
      const currentMonth = this.getCurrentMonthString();
      if (this.manifest.currentMonth !== currentMonth) {
        logger.info(`Month changed from ${this.manifest.currentMonth} to ${currentMonth}`);
        // Archive the old month if it has data
        if (this.manifest.months[this.manifest.currentMonth]?.totalJobs > 0) {
          // Old month is already saved, just update manifest
          if (!this.manifest.availableMonths.includes(this.manifest.currentMonth)) {
            this.manifest.availableMonths.unshift(this.manifest.currentMonth);
          }
        }
        this.manifest.currentMonth = currentMonth;
        await this.r2.saveManifest(this.manifest);
      }

      // Load current month stats
      const statsKey = `stats/${currentMonth}.json`;
      this.currentMonthStats = await this.r2.getJSON<MonthlyStatistics>(statsKey);

      if (!this.currentMonthStats) {
        this.currentMonthStats = this.createEmptyStatistics();
        logger.info(`Starting fresh statistics for ${currentMonth}`);
      } else {
        logger.info(`✓ Loaded stats for ${currentMonth}: ${this.currentMonthStats.totalJobs} jobs`);
      }

      this.loaded = true;
    } catch (error) {
      logger.error('Error loading from R2:', error);
      this.manifest = await this.createEmptyManifest();
      this.currentMonthStats = this.createEmptyStatistics();
      this.urlIndex = new Set();
      this.loaded = true;
    }
  }

  private async createEmptyManifest(): Promise<Manifest> {
    const currentMonth = this.getCurrentMonthString();
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      currentMonth,
      months: {},
      availableMonths: [],
      totalJobsAllTime: 0,
      schema: 'v1',
    };
  }

  /**
   * Split job into metadata and description
   */
  private splitJob(job: JobStatistic): { metadata: JobMetadata; description: JobDescription } {
    const { description, ...rest } = job;
    return {
      metadata: rest as JobMetadata,
      description: { id: job.id, description },
    };
  }

  /**
   * Combine metadata and description back into full job
   */
  private combineJob(metadata: JobMetadata, description: JobDescription): JobStatistic {
    return {
      ...metadata,
      description: description.description,
    };
  }

  /**
   * Add a job to the pending queue (will be saved on save())
   */
  addJob(job: JobStatistic): boolean {
    if (!this.loaded) {
      logger.warn('Cache not loaded yet');
      return false;
    }

    // Normalize URL for consistent deduplication
    const normalizedJobUrl = normalizeUrl(job.url);

    // Check if job already exists in R2 (using URL index)
    if (this.urlIndex.has(normalizedJobUrl)) {
      this.duplicateCount++;
      // Log first 10 duplicates with full details to help debug
      if (this.duplicateCount <= 10) {
        logger.info(`  [REJECTED ${this.duplicateCount}] Job: "${job.title?.substring(0, 40)}..."`);
        logger.info(`    → Original URL: ${job.url}`);
        logger.info(`    → Normalized:   ${normalizedJobUrl}`);
        logger.info(`    → Found in index: YES (index has ${this.urlIndex.size} URLs)`);
      }
      return false;
    }

    // Check for duplicates in pending jobs (same session)
    for (const jobs of this.pendingJobs.values()) {
      if (jobs.some(j => normalizeUrl(j.url) === normalizedJobUrl)) {
        this.duplicateCount++;
        if (this.duplicateCount <= 10) {
          logger.info(`  [REJECTED ${this.duplicateCount}] Job: "${job.title?.substring(0, 40)}..." - already in pending batch`);
        }
        return false;
      }
    }

    // Add to URL index immediately to prevent duplicates in same batch
    this.urlIndex.add(normalizedJobUrl);

    // Log first few accepted jobs for comparison
    if (this.urlIndex.size <= 5) {
      logger.info(`  [ACCEPTED] Job: "${job.title?.substring(0, 40)}..."`);
      logger.info(`    → URL added to index: ${normalizedJobUrl}`);
      logger.info(`    → Index now has ${this.urlIndex.size} URLs`);
    }

    // Group by extraction date
    const dateKey = this.getDateString(job.extractedDate);

    if (!this.pendingJobs.has(dateKey)) {
      this.pendingJobs.set(dateKey, []);
    }

    this.pendingJobs.get(dateKey)!.push(job);

    // Update statistics
    this.updateStatistics(job);

    logger.info(`✓ Queued job: ${job.title} at ${job.company} (${dateKey})`);
    return true;
  }

  /**
   * Update statistics with new job data
   */
  private updateStatistics(job: JobStatistic): void {
    if (!this.currentMonthStats) {
      this.currentMonthStats = this.createEmptyStatistics();
    }

    const stats = this.currentMonthStats;

    stats.totalJobs++;

    const dateKey = this.getDateString(job.extractedDate);
    stats.byDate[dateKey] = (stats.byDate[dateKey] || 0) + 1;

    if (job.industry) {
      stats.byIndustry[job.industry] = (stats.byIndustry[job.industry] || 0) + 1;
    }

    job.certificates.forEach(cert => {
      stats.byCertificate[cert] = (stats.byCertificate[cert] || 0) + 1;
    });

    job.keywords.forEach(keyword => {
      stats.byKeyword[keyword] = (stats.byKeyword[keyword] || 0) + 1;
    });

    if (job.seniority) {
      stats.bySeniority[job.seniority] = (stats.bySeniority[job.seniority] || 0) + 1;
    }

    if (job.location) {
      stats.byLocation[job.location] = (stats.byLocation[job.location] || 0) + 1;
    }

    if (job.country) {
      stats.byCountry[job.country] = (stats.byCountry[job.country] || 0) + 1;
    }

    const normalizedCity = normalizeCity(job.city);
    if (normalizedCity) {
      stats.byCity[normalizedCity] = (stats.byCity[normalizedCity] || 0) + 1;
    }

    if (job.region) {
      stats.byRegion[job.region] = (stats.byRegion[job.region] || 0) + 1;
    }

    if (job.company) {
      stats.byCompany[job.company] = (stats.byCompany[job.company] || 0) + 1;
    }

    if (job.software) {
      job.software.forEach(soft => {
        stats.bySoftware[soft] = (stats.bySoftware[soft] || 0) + 1;
      });
    }

    if (job.programmingSkills) {
      job.programmingSkills.forEach(skill => {
        stats.byProgrammingSkill[skill] = (stats.byProgrammingSkill[skill] || 0) + 1;
      });
    }

    if (job.yearsExperience) {
      stats.byYearsExperience[job.yearsExperience] = (stats.byYearsExperience[job.yearsExperience] || 0) + 1;
    }

    if (job.academicDegrees) {
      job.academicDegrees.forEach(degree => {
        stats.byAcademicDegree[degree] = (stats.byAcademicDegree[degree] || 0) + 1;
      });
    }

    // Update role type and category
    if (job.roleType) {
      if (!stats.byRoleType) stats.byRoleType = {};
      stats.byRoleType[job.roleType] = (stats.byRoleType[job.roleType] || 0) + 1;
    }
    if (job.roleCategory) {
      if (!stats.byRoleCategory) stats.byRoleCategory = {};
      stats.byRoleCategory[job.roleCategory] = (stats.byRoleCategory[job.roleCategory] || 0) + 1;
    }

    // Update salary stats
    this.updateSalaryStats(job);
  }

  private updateSalaryStats(job: JobStatistic): void {
    if (!job.salary || !this.currentMonthStats) return;

    const stats = this.currentMonthStats;
    if (!stats.salaryStats) {
      stats.salaryStats = {
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

    stats.salaryStats.totalWithSalary++;

    const midpoint = job.salary.min !== null && job.salary.max !== null
      ? (job.salary.min + job.salary.max) / 2
      : (job.salary.min || job.salary.max || 0);

    if (midpoint > 0) {
      stats.salaryStats.byCurrency[job.salary.currency] =
        (stats.salaryStats.byCurrency[job.salary.currency] || 0) + 1;

      if (midpoint < 30000) {
        stats.salaryStats.salaryRanges['0-30k']++;
      } else if (midpoint < 50000) {
        stats.salaryStats.salaryRanges['30-50k']++;
      } else if (midpoint < 75000) {
        stats.salaryStats.salaryRanges['50-75k']++;
      } else if (midpoint < 100000) {
        stats.salaryStats.salaryRanges['75-100k']++;
      } else if (midpoint < 150000) {
        stats.salaryStats.salaryRanges['100-150k']++;
      } else {
        stats.salaryStats.salaryRanges['150k+']++;
      }
    }
  }

  /**
   * Save all pending jobs and updated statistics to R2
   */
  async save(): Promise<void> {
    if (!this.r2.isAvailable()) {
      logger.warn('R2 not configured, skipping save');
      return;
    }

    if (!this.manifest) {
      await this.load();
    }

    const currentMonth = this.getCurrentMonthString();
    const [year, month] = currentMonth.split('-');

    // Ensure month entry exists in manifest
    if (!this.manifest!.months[currentMonth]) {
      this.manifest!.months[currentMonth] = {
        stats: `stats/${currentMonth}.json`,
        totalJobs: 0,
        days: [],
      };
    }

    const monthData = this.manifest!.months[currentMonth];

    // Save each day's data
    for (const [dateKey, jobs] of this.pendingJobs.entries()) {
      if (jobs.length === 0) continue;

      const day = dateKey.split('-')[2]; // DD

      // Load existing data for this day
      const metadataKey = `metadata/${year}/${month}/day-${day}.ndjson.gz`;
      const descriptionsKey = `descriptions/${year}/${month}/day-${day}.ndjson.gz`;

      const existingMetadata = await this.r2.getNDJSONGzipped<JobMetadata>(metadataKey);
      const existingDescriptions = await this.r2.getNDJSONGzipped<JobDescription>(descriptionsKey);

      // Merge with new jobs (avoiding duplicates) - normalize URLs for comparison
      const existingUrls = new Set(existingMetadata.map(m => normalizeUrl(m.url)));
      const newJobs = jobs.filter(j => !existingUrls.has(normalizeUrl(j.url)));

      if (newJobs.length === 0) {
        logger.info(`No new jobs to save for ${dateKey}`);
        continue;
      }

      // Split new jobs
      const newMetadata: JobMetadata[] = [];
      const newDescriptions: JobDescription[] = [];

      for (const job of newJobs) {
        const { metadata, description } = this.splitJob(job);
        newMetadata.push(metadata);
        newDescriptions.push(description);
      }

      // Combine and save
      const allMetadata = [...existingMetadata, ...newMetadata];
      const allDescriptions = [...existingDescriptions, ...newDescriptions];

      const metadataBytes = await this.r2.putNDJSONGzipped(metadataKey, allMetadata);
      const descriptionsBytes = await this.r2.putNDJSONGzipped(descriptionsKey, allDescriptions);

      // Update manifest day entry
      const existingDayIndex = monthData.days.findIndex(d => d.date === dateKey);
      const dayEntry: ManifestDay = {
        date: dateKey,
        metadata: metadataKey,
        descriptions: descriptionsKey,
        jobCount: allMetadata.length,
        metadataBytes,
        descriptionsBytes,
      };

      if (existingDayIndex >= 0) {
        monthData.days[existingDayIndex] = dayEntry;
      } else {
        monthData.days.push(dayEntry);
        monthData.days.sort((a, b) => a.date.localeCompare(b.date));
      }

      // Dual-write: also persist the day as a Parquet file (Phase 1 of the
      // storage redesign). On failure we log + continue — the NDJSON write
      // above is still authoritative, so the cron must not fail because of
      // a Parquet hiccup.
      try {
        const descById = new Map(allDescriptions.map(d => [d.id, d.description]));
        const fullJobs = allMetadata.map(m =>
          this.combineJob(m, { id: m.id, description: descById.get(m.id) ?? '' })
        );
        const { replacedKey } = await writeDailyParquet(dateKey, fullJobs, this.manifest!);
        if (replacedKey) {
          try {
            await this.r2.delete(replacedKey);
          } catch (err) {
            logger.warn(`Failed to delete prior Parquet file ${replacedKey}:`, err);
          }
        }
      } catch (err) {
        logger.error(`Parquet dual-write failed for ${dateKey} (NDJSON write still succeeded):`, err);
      }

      logger.info(`✓ Saved ${newJobs.length} new jobs for ${dateKey}`);
    }

    // Update month totals
    monthData.totalJobs = monthData.days.reduce((sum, d) => sum + d.jobCount, 0);

    // Save statistics
    if (this.currentMonthStats) {
      await this.r2.putJSON(`stats/${currentMonth}.json`, this.currentMonthStats, 'public, max-age=60');
      logger.info(`✓ Saved stats for ${currentMonth}: ${this.currentMonthStats.totalJobs} jobs`);
    }

    // Update manifest totals
    this.manifest!.totalJobsAllTime = Object.values(this.manifest!.months)
      .reduce((sum, m) => sum + m.totalJobs, 0);

    // Update available months
    this.manifest!.availableMonths = Object.keys(this.manifest!.months)
      .filter(m => this.manifest!.months[m].totalJobs > 0)
      .sort()
      .reverse();

    // Save manifest
    await this.r2.saveManifest(this.manifest!);

    // Save URL index for deduplication (critical for preventing duplicates)
    await this.r2.putJSON('url-index.json', {
      urls: Array.from(this.urlIndex),
      updatedAt: new Date().toISOString(),
      count: this.urlIndex.size,
    }, 'public, max-age=60');
    logger.info(`✓ Saved URL index: ${this.urlIndex.size} URLs`);

    // Clear pending jobs
    this.pendingJobs.clear();

    // Rebuild aggregated cache so reads never need to recompute
    await this.saveAggregatedStats();

    logger.info(`✓ Saved to R2. Total jobs all time: ${this.manifest!.totalJobsAllTime}`);
  }

  /**
   * Get current month data (compatible with old interface)
   */
  async getCurrentMonthData(): Promise<CurrentMonthData> {
    if (!this.loaded) await this.load();

    const currentMonth = this.getCurrentMonthString();
    const jobs = await this.loadJobsForMonth(currentMonth);

    return {
      month: currentMonth,
      lastUpdated: this.manifest?.updatedAt || new Date().toISOString(),
      jobs,
      statistics: this.currentMonthStats || this.createEmptyStatistics(),
    };
  }

  /**
   * Load all jobs for a specific month (metadata only, no descriptions).
   * options.date  → load only that specific date
   * options.days  → load only the last N days
   * no options    → load all days (default)
   */
  async loadJobsForMonth(
    month: string,
    options: { days?: number; date?: string } = {}
  ): Promise<JobStatistic[]> {
    if (!this.manifest?.months[month]) {
      return [];
    }

    const monthData = this.manifest.months[month];
    let daysToLoad = monthData.days;

    if (options.date) {
      daysToLoad = daysToLoad.filter(d => d.date === options.date);
    } else if (options.days) {
      daysToLoad = daysToLoad.slice(-options.days);
    }

    const dayPromises = daysToLoad.map(async (day) => {
      const metadata = await this.r2.getNDJSONGzipped<JobMetadata>(day.metadata);
      return metadata.map(m => this.combineJob(m, { id: m.id, description: '' }));
    });

    const dayResults = await Promise.all(dayPromises);
    const jobs: JobStatistic[] = [];
    for (const dayJobs of dayResults) {
      jobs.push(...dayJobs);
    }

    if (!options.date && !options.days) {
      for (const [dateKey, pendingJobs] of this.pendingJobs.entries()) {
        if (dateKey.startsWith(month)) {
          jobs.push(...pendingJobs);
        }
      }
    }

    return jobs;
  }

  /**
   * Load descriptions for a specific date on demand.
   * Returns a Map<jobId, description>. Returns empty Map on 404 or error.
   */
  async loadDescriptionsForDate(dateKey: string): Promise<Map<string, string>> {
    const [year, month, day] = dateKey.split('-');
    const descriptionsKey = `descriptions/${year}/${month}/day-${day}.ndjson.gz`;
    try {
      const descriptions = await this.r2.getNDJSONGzipped<JobDescription>(descriptionsKey);
      return new Map(descriptions.map(d => [d.id, d.description]));
    } catch {
      return new Map();
    }
  }

  /**
   * Load jobs for a specific date range (metadata only, no descriptions).
   */
  async loadJobsForDateRange(startDate: string, endDate: string): Promise<JobStatistic[]> {
    if (!this.manifest) await this.load();

    const jobs: JobStatistic[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    for (const [, monthData] of Object.entries(this.manifest!.months)) {
      for (const day of monthData.days) {
        const dayDate = new Date(day.date);
        if (dayDate >= start && dayDate <= end) {
          const metadata = await this.r2.getNDJSONGzipped<JobMetadata>(day.metadata);
          for (const m of metadata) {
            jobs.push(this.combineJob(m, { id: m.id, description: '' }));
          }
        }
      }
    }

    return jobs;
  }

  /**
   * Load only metadata for a month (no descriptions - for filtering)
   */
  async loadMetadataForMonth(month: string): Promise<JobMetadata[]> {
    if (!this.manifest?.months[month]) {
      return [];
    }

    const monthData = this.manifest.months[month];
    const metadata: JobMetadata[] = [];

    const promises = monthData.days.map(day =>
      this.r2.getNDJSONGzipped<JobMetadata>(day.metadata)
    );

    const results = await Promise.all(promises);
    for (const dayMetadata of results) {
      metadata.push(...dayMetadata);
    }

    return metadata;
  }

  /**
   * Load description for a specific job
   */
  async loadJobDescription(jobId: string, extractedDate: string): Promise<string | null> {
    const dateKey = this.getDateString(extractedDate);
    const [year, month, day] = dateKey.split('-');

    const descriptionsKey = `descriptions/${year}/${month}/day-${day}.ndjson.gz`;
    const descriptions = await this.r2.getNDJSONGzipped<JobDescription>(descriptionsKey);

    const desc = descriptions.find(d => d.id === jobId);
    return desc?.description || null;
  }

  /**
   * Get summary data (compatible with old interface)
   */
  getSummary(): SummaryData {
    const stats = this.currentMonthStats || this.createEmptyStatistics();

    return {
      lastUpdated: this.manifest?.updatedAt || new Date().toISOString(),
      totalJobsAllTime: this.manifest?.totalJobsAllTime || 0,
      currentMonth: this.manifest?.currentMonth || this.getCurrentMonthString(),
      availableArchives: this.manifest?.availableMonths.filter(m => m !== this.manifest?.currentMonth) || [],
      overallStatistics: {
        totalMonths: this.manifest?.availableMonths.length || 0,
        averageJobsPerMonth: this.manifest?.totalJobsAllTime
          ? Math.round(this.manifest.totalJobsAllTime / Math.max(this.manifest.availableMonths.length, 1))
          : 0,
        topIndustries: this.getTopN(stats.byIndustry, 10),
        topCertificates: this.getTopN(stats.byCertificate, 10),
        topKeywords: this.getTopN(stats.byKeyword, 10),
      },
    };
  }

  private getTopN(record: Record<string, number>, n: number): Record<string, number> {
    return Object.entries(record)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {} as Record<string, number>);
  }

  /**
   * Get statistics for a specific month
   */
  async getMonthStatistics(month: string): Promise<MonthlyStatistics | null> {
    const statsKey = `stats/${month}.json`;
    return await this.r2.getJSON<MonthlyStatistics>(statsKey);
  }

  /**
   * Return current month stats without downloading any job files.
   * Safe to call right after load() — uses data already in memory.
   */
  getCurrentMonthSummary(): {
    month: string;
    lastUpdated: string;
    jobCount: number;
    statistics: MonthlyStatistics;
  } {
    const currentMonth = this.manifest?.currentMonth || this.getCurrentMonthString();
    const monthData = this.manifest?.months[currentMonth];
    return {
      month: currentMonth,
      lastUpdated: this.manifest?.updatedAt || new Date().toISOString(),
      jobCount: monthData?.totalJobs || this.currentMonthStats?.totalJobs || 0,
      statistics: this.currentMonthStats || this.createEmptyStatistics(),
    };
  }

  /**
   * Compute merged statistics across all available months.
   */
  private async computeAggregatedStats(): Promise<{
    archives: ArchiveMonthData[];
    aggregated: MonthlyStatistics;
    totalJobs: number;
  }> {
    const months = this.manifest!.availableMonths;

    const statsResults = await Promise.all(
      months.map(month =>
        this.getMonthStatistics(month).then(stats => ({ month, stats }))
      )
    );

    const archives: ArchiveMonthData[] = [];
    const aggregated = this.createEmptyStatistics();
    let totalJobs = 0;

    for (const { month, stats } of statsResults) {
      if (!stats) continue;
      const monthData = this.manifest!.months[month];
      archives.push({
        month,
        statistics: stats,
        jobCount: monthData?.totalJobs || stats.totalJobs,
        archived: month !== this.manifest!.currentMonth,
      });
      totalJobs += stats.totalJobs;
      this.mergeStatistics(aggregated, stats);
    }

    aggregated.totalJobs = totalJobs;
    return { archives, aggregated, totalJobs };
  }

  /**
   * Persist aggregated stats to R2 so future reads skip computation.
   * Called from save() to keep the cache fresh after every write.
   *
   * Writes both the legacy `aggregated-stats.json` (kept until the DuckDB-WASM
   * client read path ships) and the new `stats/aggregate.json` used by the
   * Phase-2 instant-paint payload. Both are derived from the same in-memory
   * computation, so there is no extra recompute cost.
   */
  private async saveAggregatedStats(): Promise<void> {
    if (!this.manifest) return;
    const result = await this.computeAggregatedStats();
    await this.r2.putJSON('aggregated-stats.json', {
      updatedAt: new Date().toISOString(),
      ...result,
    }, 'public, max-age=60');
    logger.info(`✓ Saved aggregated stats: ${result.totalJobs} jobs across ${result.archives.length} months`);

    // Phase 2 of the storage redesign: write the small, top-N-rolled aggregate
    // the DuckDB-WASM client will use for instant first paint. Failures here
    // are non-fatal — the legacy payload above is still served.
    try {
      await writeAggregateJson({
        manifest: this.manifest,
        currentMonthStats: this.currentMonthStats || this.createEmptyStatistics(),
        archives: result.archives,
        aggregatedStats: result.aggregated,
        totalJobs: result.totalJobs,
      });
    } catch (err) {
      logger.error('Failed to write stats/aggregate.json (legacy payload still saved):', err);
    }
  }

  /**
   * Get all archives aggregated.
   * Reads from aggregated-stats.json cache first; falls back to on-demand
   * parallel computation and persists the result for next time.
   */
  async getAllArchivesAggregated(): Promise<{
    archives: ArchiveMonthData[];
    aggregated: MonthlyStatistics;
    totalJobs: number;
  }> {
    if (!this.manifest) await this.load();

    const cached = await this.r2.getJSON<{
      updatedAt: string;
      archives: ArchiveMonthData[];
      aggregated: MonthlyStatistics;
      totalJobs: number;
    }>('aggregated-stats.json');

    if (cached) {
      logger.info(`✓ Loaded aggregated stats from cache: ${cached.totalJobs} jobs across ${cached.archives.length} months`);
      return { archives: cached.archives, aggregated: cached.aggregated, totalJobs: cached.totalJobs };
    }

    logger.info('Aggregated stats cache miss — computing from individual month files...');
    const result = await this.computeAggregatedStats();

    // Persist so next request hits the cache
    await this.r2.putJSON('aggregated-stats.json', {
      updatedAt: new Date().toISOString(),
      ...result,
    }, 'public, max-age=60');
    logger.info(`✓ Computed and cached aggregated stats: ${result.totalJobs} jobs`);

    return result;
  }

  private mergeStatistics(target: MonthlyStatistics, source: MonthlyStatistics): void {
    // Helper to merge Record<string, number> fields
    const mergeRecord = (
      targetRec: Record<string, number>,
      sourceRec: Record<string, number> | undefined
    ) => {
      if (!sourceRec) return;
      for (const [key, value] of Object.entries(sourceRec)) {
        targetRec[key] = (targetRec[key] || 0) + value;
      }
    };

    mergeRecord(target.byDate, source.byDate);
    mergeRecord(target.byIndustry, source.byIndustry);
    mergeRecord(target.byCertificate, source.byCertificate);
    mergeRecord(target.byKeyword, source.byKeyword);
    mergeRecord(target.bySeniority, source.bySeniority);
    mergeRecord(target.byLocation, source.byLocation);
    mergeRecord(target.byCountry, source.byCountry);
    mergeRecord(target.byCity, source.byCity);
    mergeRecord(target.byRegion, source.byRegion);
    mergeRecord(target.byCompany, source.byCompany);
    mergeRecord(target.bySoftware, source.bySoftware);
    mergeRecord(target.byProgrammingSkill, source.byProgrammingSkill);
    mergeRecord(target.byYearsExperience, source.byYearsExperience);
    mergeRecord(target.byAcademicDegree, source.byAcademicDegree);

    // Merge role type and category
    if (source.byRoleType) {
      if (!target.byRoleType) target.byRoleType = {};
      mergeRecord(target.byRoleType, source.byRoleType);
    }
    if (source.byRoleCategory) {
      if (!target.byRoleCategory) target.byRoleCategory = {};
      mergeRecord(target.byRoleCategory, source.byRoleCategory);
    }

    // Merge time-based data
    if (source.byHour) {
      if (!target.byHour) target.byHour = {};
      mergeRecord(target.byHour, source.byHour);
    }
    if (source.byDayHour) {
      if (!target.byDayHour) target.byDayHour = {};
      mergeRecord(target.byDayHour, source.byDayHour);
    }

    // Merge salary statistics
    if (source.salaryStats && source.salaryStats.totalWithSalary > 0) {
      if (!target.salaryStats) {
        target.salaryStats = {
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

      const ts = target.salaryStats;
      const ss = source.salaryStats;

      // Weighted average for overall salary
      const targetTotal = ts.totalWithSalary;
      const sourceTotal = ss.totalWithSalary;
      const combinedTotal = targetTotal + sourceTotal;

      if (ss.averageSalary !== null) {
        if (ts.averageSalary !== null && targetTotal > 0) {
          ts.averageSalary = Math.round(
            (ts.averageSalary * targetTotal + ss.averageSalary * sourceTotal) / combinedTotal
          );
        } else {
          ts.averageSalary = ss.averageSalary;
        }
      }

      if (ss.medianSalary !== null) {
        if (ts.medianSalary !== null && targetTotal > 0) {
          // Weighted approximation of median
          ts.medianSalary = Math.round(
            (ts.medianSalary * targetTotal + ss.medianSalary * sourceTotal) / combinedTotal
          );
        } else {
          ts.medianSalary = ss.medianSalary;
        }
      }

      ts.totalWithSalary = combinedTotal;

      // Merge salary ranges
      const rangeKeys = ['0-30k', '30-50k', '50-75k', '75-100k', '100-150k', '150k+'] as const;
      for (const key of rangeKeys) {
        ts.salaryRanges[key] = (ts.salaryRanges[key] || 0) + (ss.salaryRanges[key] || 0);
      }

      // Merge currency counts
      mergeRecord(ts.byCurrency, ss.byCurrency);

      // Helper to merge grouped salary stats (byIndustry, bySeniority, etc.)
      const mergeGroupedSalary = (
        targetGroup: Record<string, { avg: number; median: number; count: number }>,
        sourceGroup: Record<string, { avg: number; median: number; count: number }>
      ) => {
        for (const [key, srcVal] of Object.entries(sourceGroup)) {
          if (targetGroup[key]) {
            const tgt = targetGroup[key];
            const combined = tgt.count + srcVal.count;
            tgt.avg = Math.round((tgt.avg * tgt.count + srcVal.avg * srcVal.count) / combined);
            tgt.median = Math.round((tgt.median * tgt.count + srcVal.median * srcVal.count) / combined);
            tgt.count = combined;
          } else {
            targetGroup[key] = { ...srcVal };
          }
        }
      };

      mergeGroupedSalary(ts.byIndustry, ss.byIndustry);
      mergeGroupedSalary(ts.bySeniority, ss.bySeniority);
      mergeGroupedSalary(ts.byLocation, ss.byLocation);
      mergeGroupedSalary(ts.byCountry, ss.byCountry);
      mergeGroupedSalary(ts.byCity, ss.byCity);
    }
  }

  /**
   * Check if job URL already exists
   */
  async jobExists(url: string): Promise<boolean> {
    // Check pending jobs first
    for (const jobs of this.pendingJobs.values()) {
      if (jobs.some(j => j.url === url)) {
        return true;
      }
    }

    // Check current month in R2
    const currentMonth = this.getCurrentMonthString();
    const metadata = await this.loadMetadataForMonth(currentMonth);
    return metadata.some(m => m.url === url);
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      currentMonth: this.manifest?.currentMonth || this.getCurrentMonthString(),
      currentMonthJobs: this.currentMonthStats?.totalJobs || 0,
      totalJobsAllTime: this.manifest?.totalJobsAllTime || 0,
      availableArchives: this.manifest?.availableMonths.length || 0,
      storageType: 'Cloudflare R2',
      pendingJobs: Array.from(this.pendingJobs.values()).reduce((sum, jobs) => sum + jobs.length, 0),
    };
  }

  /**
   * Get URL index size (for debugging)
   */
  getUrlIndexSize(): number {
    return this.urlIndex.size;
  }

  /**
   * Cheap lookup against the in-memory URL index for "is this job already
   * stored?" — without running addJob's full path.
   *
   * Lets callers (the cron route) short-circuit the heavy metadata/salary/
   * location/role-type extractor pipeline for jobs we're about to reject as
   * duplicates anyway. The 95%+ of RSS items that are duplicates on every
   * tick become free this way.
   *
   * Returns false if the cache hasn't loaded yet — callers will then run
   * the full path and `addJob` will catch any duplicates that slip through.
   */
  isKnownUrl(url: string): boolean {
    if (!this.loaded) return false;
    return this.urlIndex.has(normalizeUrl(url));
  }

  /**
   * Get current month statistics
   */
  getCurrentStatistics(): MonthlyStatistics {
    return this.currentMonthStats || this.createEmptyStatistics();
  }

  /**
   * Get manifest (for API responses)
   */
  getManifest(): Manifest | null {
    return this.manifest;
  }
}

// Singleton instance
let cacheInstance: JobStatisticsCacheR2 | null = null;

export function getJobStatisticsCacheR2(): JobStatisticsCacheR2 {
  if (!cacheInstance) {
    cacheInstance = new JobStatisticsCacheR2();
  }
  return cacheInstance;
}
