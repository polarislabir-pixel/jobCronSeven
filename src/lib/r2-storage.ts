import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { logger } from './logger';
import { gzipSync, gunzipSync } from 'zlib';

/**
 * R2 Storage Service
 *
 * Handles all interactions with Cloudflare R2 for job statistics storage.
 * Uses S3-compatible API with gzip compression for efficient storage.
 *
 * File structure in R2:
 * - manifest.json                          (index of all data)
 * - stats/current.json                     (pre-computed statistics)
 * - stats/archive/YYYY-MM.json             (archived month statistics)
 * - metadata/YYYY/MM/day-DD.ndjson.gz      (job metadata without descriptions)
 * - descriptions/YYYY/MM/day-DD.ndjson.gz  (job descriptions only)
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}

export interface ManifestDay {
  date: string;                    // YYYY-MM-DD
  metadata: string;                // path to metadata file
  descriptions: string;            // path to descriptions file
  jobCount: number;
  metadataBytes: number;
  descriptionsBytes: number;
}

export interface ManifestMonth {
  stats: string;                   // path to stats file
  totalJobs: number;
  days: ManifestDay[];
}

export interface Manifest {
  version: number;
  updatedAt: string;
  currentMonth: string;            // YYYY-MM
  months: Record<string, ManifestMonth>;
  availableMonths: string[];       // sorted, most recent first
  totalJobsAllTime: number;
  schema: string;
}

export class R2Storage {
  private client: S3Client;
  private bucketName: string;
  private publicUrl: string;
  private isConfigured: boolean;

  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    this.isConfigured = !!(accountId && accessKeyId && secretAccessKey && bucketName);
    this.bucketName = bucketName || '';
    this.publicUrl = publicUrl || '';

    if (this.isConfigured) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
        },
      });
      logger.info('R2 Storage initialized');
    } else {
      // Create a dummy client - will fail if used without configuration
      this.client = new S3Client({ region: 'auto' });
      logger.warn('R2 Storage not configured - missing environment variables');
    }
  }

  /**
   * Check if R2 is properly configured
   */
  isAvailable(): boolean {
    return this.isConfigured;
  }

  /**
   * Get the public URL for a file
   */
  getPublicUrl(key: string): string {
    return `${this.publicUrl}/${key}`;
  }

  /**
   * Upload a JSON file (uncompressed)
   */
  async putJSON(key: string, data: unknown, cacheControl?: string): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('R2 Storage not configured');
    }

    const body = JSON.stringify(data, null, 2);

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      CacheControl: cacheControl || 'public, max-age=60',
    }));

    logger.info(`✓ Uploaded JSON: ${key} (${body.length} bytes)`);
  }

  /**
   * Upload a gzipped NDJSON file
   */
  async putNDJSONGzipped(key: string, records: unknown[]): Promise<number> {
    if (!this.isConfigured) {
      throw new Error('R2 Storage not configured');
    }

    // Convert to NDJSON (newline-delimited JSON)
    const ndjson = records.map(r => JSON.stringify(r)).join('\n');

    // Compress with gzip
    const compressed = gzipSync(Buffer.from(ndjson, 'utf-8'));

    await this.client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: compressed,
      ContentType: 'application/x-ndjson',
      ContentEncoding: 'gzip',
      CacheControl: 'public, max-age=31536000, immutable', // Immutable for chunked data
    }));

    logger.info(`✓ Uploaded NDJSON.gz: ${key} (${compressed.length} bytes compressed)`);
    return compressed.length;
  }

  /**
   * Get a JSON file
   */
  async getJSON<T>(key: string): Promise<T | null> {
    if (!this.isConfigured) {
      throw new Error('R2 Storage not configured');
    }

    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));

      const body = await response.Body?.transformToString();
      if (!body) {
        return null;
      }

      return JSON.parse(body) as T;
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a gzipped NDJSON file and parse it
   */
  async getNDJSONGzipped<T>(key: string): Promise<T[]> {
    if (!this.isConfigured) {
      throw new Error('R2 Storage not configured');
    }

    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));

      const body = await response.Body?.transformToByteArray();
      if (!body) {
        return [];
      }

      // Decompress
      const decompressed = gunzipSync(Buffer.from(body));
      const ndjson = decompressed.toString('utf-8');

      // Parse NDJSON
      return ndjson
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line) as T);
    } catch (error: any) {
      if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Check if a file exists
   */
  async exists(key: string): Promise<boolean> {
    if (!this.isConfigured) {
      return false;
    }

    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      }));
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Delete a file
   */
  async delete(key: string): Promise<void> {
    if (!this.isConfigured) {
      throw new Error('R2 Storage not configured');
    }

    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    }));

    logger.info(`✓ Deleted: ${key}`);
  }

  /**
   * List files with a prefix
   */
  async list(prefix: string): Promise<string[]> {
    if (!this.isConfigured) {
      return [];
    }

    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    }));

    return (response.Contents || [])
      .map(obj => obj.Key!)
      .filter(Boolean);
  }

  /**
   * Get or initialize manifest
   */
  async getManifest(): Promise<Manifest> {
    const manifest = await this.getJSON<Manifest>('manifest.json');

    if (manifest) {
      return manifest;
    }

    // Create initial manifest
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const initialManifest: Manifest = {
      version: 1,
      updatedAt: now.toISOString(),
      currentMonth,
      months: {},
      availableMonths: [],
      totalJobsAllTime: 0,
      schema: 'v1',
    };

    await this.putJSON('manifest.json', initialManifest, 'public, max-age=60');
    return initialManifest;
  }

  /**
   * Save manifest
   */
  async saveManifest(manifest: Manifest): Promise<void> {
    manifest.updatedAt = new Date().toISOString();
    await this.putJSON('manifest.json', manifest, 'public, max-age=60');
  }
}

// Singleton instance
let r2StorageInstance: R2Storage | null = null;

export function getR2Storage(): R2Storage {
  if (!r2StorageInstance) {
    r2StorageInstance = new R2Storage();
  }
  return r2StorageInstance;
}
