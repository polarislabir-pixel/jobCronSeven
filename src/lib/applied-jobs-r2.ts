import { getR2Storage } from './r2-storage';
import { logger } from './logger';
import { AppliedJob, AppliedJobsManifest, TrackingJobData } from '@/types/applied-job';
import { generateJobId } from './tracking-url';
import { LocationExtractor, normalizeCity } from './location-extractor';

/**
 * Applied Jobs R2 Storage
 *
 * Stores job application tracking data in R2, scoped by namespace.
 *
 * File structure (per namespace):
 * - <prefix>/manifest.json           (index of all applications)
 * - <prefix>/YYYY-MM.ndjson.gz       (monthly application records)
 *
 * Namespaces:
 * - "default" → applied/        (main pipeline)
 * - "aryan"   → applied-aryan/  (aryan pipeline)
 */

export type AppliedNamespace = 'default' | 'aryan';

export function isAppliedNamespace(value: string | null | undefined): value is AppliedNamespace {
  return value === 'default' || value === 'aryan';
}

export function getAppliedPrefix(namespace: AppliedNamespace): string {
  return namespace === 'aryan' ? 'applied-aryan' : 'applied';
}

export class AppliedJobsR2Storage {
  private r2 = getR2Storage();
  private manifest: AppliedJobsManifest | null = null;
  private pendingApplications: AppliedJob[] = [];
  private appliedUrls: Set<string> = new Set();
  private loaded = false;
  private readonly namespace: AppliedNamespace;
  private readonly prefix: string;
  private readonly manifestKey: string;

  constructor(namespace: AppliedNamespace = 'default') {
    this.namespace = namespace;
    this.prefix = getAppliedPrefix(namespace);
    this.manifestKey = `${this.prefix}/manifest.json`;
  }

  /**
   * Check if R2 is available
   */
  isAvailable(): boolean {
    return this.r2.isAvailable();
  }

  /**
   * Load manifest and URL index
   */
  async load(): Promise<void> {
    if (this.loaded) return;

    if (!this.r2.isAvailable()) {
      logger.warn('R2 not available for applied jobs storage');
      this.manifest = this.createEmptyManifest();
      this.loaded = true;
      return;
    }

    try {
      // Load manifest
      this.manifest = await this.r2.getJSON<AppliedJobsManifest>(this.manifestKey);

      if (!this.manifest) {
        this.manifest = this.createEmptyManifest();
      }

      // Load all existing application URLs for deduplication
      await this.loadAppliedUrls();

      this.loaded = true;
      logger.info(`Applied jobs manifest loaded [${this.namespace}]: ${this.manifest.totalApplications} total applications`);
    } catch (error) {
      logger.error('Failed to load applied jobs manifest:', error);
      this.manifest = this.createEmptyManifest();
      this.loaded = true;
    }
  }

  /**
   * Create empty manifest
   */
  private createEmptyManifest(): AppliedJobsManifest {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      totalApplications: 0,
      applicationsByMonth: {},
    };
  }

  /**
   * Load all applied URLs for deduplication
   */
  private async loadAppliedUrls(): Promise<void> {
    if (!this.manifest) return;

    for (const month of Object.keys(this.manifest.applicationsByMonth)) {
      try {
        const applications = await this.r2.getNDJSONGzipped<AppliedJob>(
          `${this.prefix}/${month}.ndjson.gz`
        );
        for (const app of applications) {
          this.appliedUrls.add(app.originalUrl);
        }
      } catch (error) {
        logger.warn(`Failed to load applied jobs for ${month}:`, error);
      }
    }
  }

  /**
   * Check if a job URL has already been applied to
   */
  hasApplied(jobUrl: string): boolean {
    return this.appliedUrls.has(jobUrl) ||
      this.pendingApplications.some(app => app.originalUrl === jobUrl);
  }

  /**
   * Add a new job application
   */
  async addApplication(jobData: TrackingJobData): Promise<AppliedJob | null> {
    if (!this.loaded) {
      await this.load();
    }

    // Check for duplicate
    if (this.hasApplied(jobData.jobUrl)) {
      logger.info(`Already applied to job: ${jobData.title}`);
      return null;
    }

    const jobId = generateJobId(jobData.jobUrl);
    const now = new Date();

    // Extract and normalize location data
    const locationData = LocationExtractor.extractLocation(
      jobData.location,
      jobData.jobUrl,
      null,
      ''
    );
    const normalizedCity = normalizeCity(locationData.city);

    const application: AppliedJob = {
      id: `${jobId}-${now.getTime()}`,
      jobId,
      appliedAt: now.toISOString(),
      jobTitle: jobData.title,
      company: jobData.company,
      location: jobData.location,
      city: normalizedCity || undefined,
      country: locationData.country || undefined,
      region: locationData.region || undefined,
      originalUrl: jobData.jobUrl,
      postedDate: jobData.postedDate,
      roleType: jobData.roleType,
      industry: jobData.industry,
    };

    this.pendingApplications.push(application);
    this.appliedUrls.add(jobData.jobUrl);

    logger.info(`Added application: ${application.jobTitle} at ${application.company}`);

    return application;
  }

  /**
   * Save pending applications to R2
   */
  async save(): Promise<void> {
    if (!this.r2.isAvailable()) {
      logger.warn('R2 not available - cannot save applied jobs');
      return;
    }

    if (this.pendingApplications.length === 0) {
      logger.info('No pending applications to save');
      return;
    }

    if (!this.manifest) {
      this.manifest = this.createEmptyManifest();
    }

    // Group pending applications by month
    const byMonth: Record<string, AppliedJob[]> = {};

    for (const app of this.pendingApplications) {
      const month = app.appliedAt.substring(0, 7); // YYYY-MM
      if (!byMonth[month]) {
        byMonth[month] = [];
      }
      byMonth[month].push(app);
    }

    // Save each month's data
    for (const [month, applications] of Object.entries(byMonth)) {
      const key = `${this.prefix}/${month}.ndjson.gz`;

      // Load existing data for this month
      let existingApps: AppliedJob[] = [];
      try {
        existingApps = await this.r2.getNDJSONGzipped<AppliedJob>(key);
      } catch {
        // File doesn't exist yet
      }

      // Merge and deduplicate
      const allApps = [...existingApps, ...applications];
      const uniqueApps = this.deduplicateApplications(allApps);

      // Upload merged data
      await this.r2.putNDJSONGzipped(key, uniqueApps);

      // Update manifest
      this.manifest.applicationsByMonth[month] = uniqueApps.length;
    }

    // Update manifest totals
    this.manifest.totalApplications = Object.values(
      this.manifest.applicationsByMonth
    ).reduce((sum, count) => sum + count, 0);

    this.manifest.updatedAt = new Date().toISOString();

    // Save manifest
    await this.r2.putJSON(this.manifestKey, this.manifest, 'public, max-age=60');

    logger.info(`Saved ${this.pendingApplications.length} applications to R2 [${this.namespace}]`);

    // Clear pending
    this.pendingApplications = [];
  }

  /**
   * Deduplicate applications by URL
   */
  private deduplicateApplications(applications: AppliedJob[]): AppliedJob[] {
    const seen = new Map<string, AppliedJob>();

    for (const app of applications) {
      // Keep the earliest application for each URL
      if (!seen.has(app.originalUrl)) {
        seen.set(app.originalUrl, app);
      }
    }

    return Array.from(seen.values()).sort(
      (a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()
    );
  }

  /**
   * Get all applications
   */
  async getApplications(month?: string): Promise<AppliedJob[]> {
    if (!this.loaded) {
      await this.load();
    }

    if (!this.r2.isAvailable() || !this.manifest) {
      return this.pendingApplications;
    }

    if (month) {
      // Get specific month
      try {
        const apps = await this.r2.getNDJSONGzipped<AppliedJob>(
          `${this.prefix}/${month}.ndjson.gz`
        );
        return [...apps, ...this.pendingApplications.filter(
          app => app.appliedAt.startsWith(month)
        )].sort(
          (a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()
        );
      } catch {
        return this.pendingApplications.filter(
          app => app.appliedAt.startsWith(month)
        );
      }
    }

    // Get all months
    const allApps: AppliedJob[] = [...this.pendingApplications];

    for (const m of Object.keys(this.manifest.applicationsByMonth)) {
      try {
        const apps = await this.r2.getNDJSONGzipped<AppliedJob>(
          `${this.prefix}/${m}.ndjson.gz`
        );
        allApps.push(...apps);
      } catch {
        // Skip months that fail to load
      }
    }

    // Deduplicate and sort
    return this.deduplicateApplications(allApps);
  }

  /**
   * Get statistics
   */
  async getStats(): Promise<{
    totalApplications: number;
    applicationsByMonth: Record<string, number>;
    lastUpdated: string;
  }> {
    if (!this.loaded) {
      await this.load();
    }

    return {
      totalApplications: (this.manifest?.totalApplications || 0) + this.pendingApplications.length,
      applicationsByMonth: this.manifest?.applicationsByMonth || {},
      lastUpdated: this.manifest?.updatedAt || new Date().toISOString(),
    };
  }

  /**
   * Clear all applied jobs data
   */
  async clearAll(): Promise<{ deletedMonths: string[]; totalDeleted: number }> {
    if (!this.r2.isAvailable()) {
      throw new Error('R2 not available');
    }

    if (!this.loaded) {
      await this.load();
    }

    const deletedMonths: string[] = [];
    let totalDeleted = 0;

    if (this.manifest) {
      // Delete all monthly files
      for (const month of Object.keys(this.manifest.applicationsByMonth)) {
        try {
          await this.r2.delete(`${this.prefix}/${month}.ndjson.gz`);
          totalDeleted += this.manifest.applicationsByMonth[month];
          deletedMonths.push(month);
          logger.info(`Deleted applied jobs for ${month} [${this.namespace}]`);
        } catch (error) {
          logger.warn(`Failed to delete ${this.prefix}/${month}.ndjson.gz:`, error);
        }
      }

      // Reset manifest
      this.manifest = this.createEmptyManifest();
      await this.r2.putJSON(this.manifestKey, this.manifest, 'public, max-age=60');
    }

    // Clear in-memory state
    this.pendingApplications = [];
    this.appliedUrls.clear();

    logger.info(`Cleared all applied jobs [${this.namespace}]: ${totalDeleted} total from ${deletedMonths.length} months`);

    return { deletedMonths, totalDeleted };
  }
}

// Singleton instances per namespace
const appliedJobsInstances: Partial<Record<AppliedNamespace, AppliedJobsR2Storage>> = {};

export function getAppliedJobsStorage(namespace: AppliedNamespace = 'default'): AppliedJobsR2Storage {
  let instance = appliedJobsInstances[namespace];
  if (!instance) {
    instance = new AppliedJobsR2Storage(namespace);
    appliedJobsInstances[namespace] = instance;
  }
  return instance;
}
