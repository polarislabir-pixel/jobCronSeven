/**
 * Parquet-on-R2 storage layer.
 *
 * Lives alongside the existing NDJSON cache during the dual-write phase
 * described in STORAGE_REDESIGN_PROPOSAL.md. The NDJSON path remains
 * authoritative until the DuckDB-WASM client read path ships and the
 * aggregate.json fast-paint is verified.
 *
 * Schema deviation from the proposal:
 *   The proposal specifies LIST<STRING> for keywords/certificates/etc. and
 *   STRUCT for salary. hyparquet-writer does not have first-class nested
 *   support across all type combinations we need, so we encode list columns
 *   as JSON-string columns and flatten salary into salary_{min,max,currency,period}.
 *   DuckDB consumes both cleanly:
 *     - lists:  json_extract(col, '$[*]')  /  unnest(from_json(col, '...'))
 *     - salary: regular column reads
 *   This trades ~5-10% column size for a simpler, supported writer path.
 */

import { createHash } from 'crypto';
import { logger } from './logger';
import {
  getR2Storage,
  type Manifest,
  type ParquetManifest,
  type ParquetFileRef,
} from './r2-storage';
import type { JobStatistic, MonthlyStatistics } from './job-statistics-r2';

// Lazy handle for the Parquet writer. Imported on first encode so cron ticks
// that don't actually write Parquet (no-op ticks after dedup-first) don't
// pay the module-load cost on cold starts.
let _parquetWriteBuffer: ((options: unknown) => ArrayBuffer) | null = null;
async function getParquetWriteBuffer() {
  if (!_parquetWriteBuffer) {
    const mod = await import('hyparquet-writer');
    _parquetWriteBuffer = mod.parquetWriteBuffer as unknown as typeof _parquetWriteBuffer;
  }
  return _parquetWriteBuffer!;
}

const PARQUET_MANIFEST_VERSION = 1;
const AGGREGATE_VERSION = 1;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

interface ParquetColumn {
  name: string;
  data: (string | number | null)[];
  type: 'STRING' | 'INT64' | 'DOUBLE' | 'BOOLEAN';
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function nullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

/**
 * Encode an array of JobStatistic rows as a single Parquet file.
 *
 * Returns the raw bytes. Caller persists them to R2 and updates the manifest.
 * Async because hyparquet-writer is lazy-imported on first use.
 */
export async function encodeJobsAsParquet(jobs: JobStatistic[]): Promise<Uint8Array> {
  const columns: ParquetColumn[] = [
    { name: 'id',                data: jobs.map(j => j.id ?? ''),                                    type: 'STRING' },
    { name: 'title',             data: jobs.map(j => j.title ?? ''),                                 type: 'STRING' },
    { name: 'company',           data: jobs.map(j => j.company ?? ''),                               type: 'STRING' },
    { name: 'url',               data: jobs.map(j => j.url ?? ''),                                   type: 'STRING' },
    { name: 'postedDate',        data: jobs.map(j => j.postedDate ?? ''),                            type: 'STRING' },
    { name: 'extractedDate',     data: jobs.map(j => j.extractedDate ?? ''),                         type: 'STRING' },
    { name: 'country',           data: jobs.map(j => nullableString(j.country)),                     type: 'STRING' },
    { name: 'city',              data: jobs.map(j => nullableString(j.city)),                        type: 'STRING' },
    { name: 'region',            data: jobs.map(j => nullableString(j.region)),                      type: 'STRING' },
    { name: 'location',          data: jobs.map(j => j.location ?? ''),                              type: 'STRING' },
    { name: 'industry',          data: jobs.map(j => j.industry ?? ''),                              type: 'STRING' },
    { name: 'seniority',         data: jobs.map(j => j.seniority ?? ''),                             type: 'STRING' },
    { name: 'roleType',          data: jobs.map(j => nullableString(j.roleType ?? null)),            type: 'STRING' },
    { name: 'roleCategory',      data: jobs.map(j => nullableString(j.roleCategory ?? null)),        type: 'STRING' },
    { name: 'yearsExperience',   data: jobs.map(j => nullableString(j.yearsExperience ?? null)),     type: 'STRING' },
    { name: 'keywords',          data: jobs.map(j => jsonOrNull(j.keywords ?? [])),                  type: 'STRING' },
    { name: 'certificates',      data: jobs.map(j => jsonOrNull(j.certificates ?? [])),              type: 'STRING' },
    { name: 'software',          data: jobs.map(j => jsonOrNull(j.software ?? [])),                  type: 'STRING' },
    { name: 'programmingSkills', data: jobs.map(j => jsonOrNull(j.programmingSkills ?? [])),         type: 'STRING' },
    { name: 'academicDegrees',   data: jobs.map(j => jsonOrNull(j.academicDegrees ?? [])),           type: 'STRING' },
    { name: 'salary_min',        data: jobs.map(j => j.salary?.min ?? null),                         type: 'DOUBLE' },
    { name: 'salary_max',        data: jobs.map(j => j.salary?.max ?? null),                         type: 'DOUBLE' },
    { name: 'salary_currency',   data: jobs.map(j => nullableString(j.salary?.currency ?? null)),    type: 'STRING' },
    { name: 'salary_period',     data: jobs.map(j => nullableString(j.salary?.period ?? null)),      type: 'STRING' },
    { name: 'description',       data: jobs.map(j => j.description ?? ''),                           type: 'STRING' },
  ];

  // hyparquet-writer returns either ArrayBuffer or Uint8Array depending on version.
  // Normalize to Uint8Array regardless.
  const writer = await getParquetWriteBuffer();
  const raw = writer({ columnData: columns });
  const bytes = raw instanceof Uint8Array
    ? raw
    : new Uint8Array(raw as ArrayBuffer);
  return bytes;
}

// ---------------------------------------------------------------------------
// File layout
// ---------------------------------------------------------------------------

/** jobs/YYYY/MM/DD-<hash8>.parquet */
function dailyParquetKey(date: string, contentHashShort: string): string {
  const [year, month, day] = date.split('-');
  return `jobs/${year}/${month}/${day}-${contentHashShort}.parquet`;
}

/** jobs/YYYY-MM-<hash8>.parquet */
function monthlyParquetKey(month: string, contentHashShort: string): string {
  return `jobs/${month}-${contentHashShort}.parquet`;
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface WriteDailyParquetResult {
  date: string;
  ref: ParquetFileRef;
  replacedKey: string | null;  // Previous file key, if any (caller should delete it).
}

/**
 * Write all jobs for a single day as one Parquet file, then update the
 * manifest's parquet.daily entry. Replaces (and returns the key of) the
 * prior file for that date so the caller can delete it.
 *
 * `jobs` should be the FULL set of jobs for the day — this is a rewrite,
 * not an append. The proposal's append model is implemented via "load
 * existing + merge new + rewrite" by the caller before invoking this.
 */
export async function writeDailyParquet(
  date: string,
  jobs: JobStatistic[],
  manifest: Manifest,
): Promise<WriteDailyParquetResult> {
  const r2 = getR2Storage();

  const bytes = await encodeJobsAsParquet(jobs);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const shortHash = contentHash.slice(0, 8);
  const key = dailyParquetKey(date, shortHash);

  await r2.putParquet(key, bytes);

  const ref: ParquetFileRef = {
    key,
    url: r2.getPublicUrl(key),
    rowCount: jobs.length,
    byteSize: bytes.length,
    contentHash,
    updatedAt: new Date().toISOString(),
  };

  // Splice into manifest. Capture previous key for deletion.
  if (!manifest.parquet) {
    manifest.parquet = {
      version: PARQUET_MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      daily: {},
      monthly: {},
    };
  }
  const previous = manifest.parquet.daily[date] ?? null;
  manifest.parquet.daily[date] = ref;
  manifest.parquet.updatedAt = new Date().toISOString();

  return { date, ref, replacedKey: previous?.key ?? null };
}

/**
 * Compact every daily Parquet file in a closed month into one monthly file.
 * Deletes the daily files after the monthly write succeeds.
 *
 * Returns the manifest ref so the caller can persist the updated manifest.
 */
export async function compactMonthlyParquet(
  month: string,
  jobs: JobStatistic[],
  manifest: Manifest,
): Promise<{ ref: ParquetFileRef; deletedKeys: string[] }> {
  const r2 = getR2Storage();

  const bytes = await encodeJobsAsParquet(jobs);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const shortHash = contentHash.slice(0, 8);
  const key = monthlyParquetKey(month, shortHash);

  await r2.putParquet(key, bytes);

  const ref: ParquetFileRef = {
    key,
    url: r2.getPublicUrl(key),
    rowCount: jobs.length,
    byteSize: bytes.length,
    contentHash,
    updatedAt: new Date().toISOString(),
  };

  if (!manifest.parquet) {
    manifest.parquet = {
      version: PARQUET_MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      daily: {},
      monthly: {},
    };
  }

  // Collect daily files in this month to drop.
  const deletedKeys: string[] = [];
  for (const [date, dailyRef] of Object.entries(manifest.parquet.daily)) {
    if (date.startsWith(`${month}-`)) {
      deletedKeys.push(dailyRef.key);
      delete manifest.parquet.daily[date];
    }
  }
  // Replace any previous monthly file for the same month.
  const previousMonthly = manifest.parquet.monthly[month] ?? null;
  if (previousMonthly) deletedKeys.push(previousMonthly.key);

  manifest.parquet.monthly[month] = ref;
  manifest.parquet.updatedAt = new Date().toISOString();

  // Best-effort deletion of obsolete files.
  for (const oldKey of deletedKeys) {
    try {
      await r2.delete(oldKey);
    } catch (err) {
      logger.warn(`Failed to delete obsolete Parquet file ${oldKey}:`, err);
    }
  }

  return { ref, deletedKeys };
}

// ---------------------------------------------------------------------------
// aggregate.json — instant-paint payload (Phase 2 of the proposal)
// ---------------------------------------------------------------------------

const TOP_N = 50;

export interface AggregateJson {
  version: number;
  updatedAt: string;
  totalJobs: number;
  currentMonth: string;
  monthsCovered: string[];

  // The whole, fully-aggregated MonthlyStatistics for ALL time.
  // Mirrors what `/api/stats/load` currently returns as `aggregated.statistics`
  // so the existing dashboard can render from it 1:1.
  statistics: MonthlyStatistics;

  // Per-month archive summaries for the year-over-year / multi-month charts.
  // Same shape /api/stats/load already returns under `aggregated.archives`.
  archives: Array<{
    month: string;
    jobCount: number;
    statistics: MonthlyStatistics;
  }>;

  // Top-N pre-rolled facets for instant paint without parsing the full statistics.
  // The dashboard can fall back to these when statistics are not yet hydrated.
  top: {
    industries: Record<string, number>;
    countries: Record<string, number>;
    cities: Record<string, number>;
    companies: Record<string, number>;
    keywords: Record<string, number>;
    certificates: Record<string, number>;
    seniorities: Record<string, number>;
    regions: Record<string, number>;
    software: Record<string, number>;
    programmingSkills: Record<string, number>;
  };

  // Pointers into the Parquet layout so the client can register files
  // with DuckDB-WASM without a second manifest fetch.
  parquet: ParquetManifest | null;
}

function topNRecord(record: Record<string, number> | undefined, n = TOP_N): Record<string, number> {
  if (!record) return {};
  return Object.entries(record)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .reduce<Record<string, number>>((acc, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});
}

export interface AggregateInput {
  manifest: Manifest;
  currentMonthStats: MonthlyStatistics;
  archives: Array<{ month: string; jobCount: number; statistics: MonthlyStatistics }>;
  aggregatedStats: MonthlyStatistics;
  totalJobs: number;
}

/**
 * Build and persist stats/aggregate.json. Called from the cron write path
 * after the existing NDJSON save() completes — the same MonthlyStatistics
 * the legacy cache already maintains is reused, so this adds no recompute.
 */
export async function writeAggregateJson(input: AggregateInput): Promise<void> {
  const r2 = getR2Storage();
  const { manifest, currentMonthStats, archives, aggregatedStats, totalJobs } = input;

  const payload: AggregateJson = {
    version: AGGREGATE_VERSION,
    updatedAt: new Date().toISOString(),
    totalJobs,
    currentMonth: manifest.currentMonth,
    monthsCovered: manifest.availableMonths,
    statistics: aggregatedStats,
    archives,
    top: {
      industries:        topNRecord(aggregatedStats.byIndustry),
      countries:         topNRecord(aggregatedStats.byCountry),
      cities:            topNRecord(aggregatedStats.byCity),
      companies:         topNRecord(aggregatedStats.byCompany),
      keywords:          topNRecord(aggregatedStats.byKeyword),
      certificates:      topNRecord(aggregatedStats.byCertificate),
      seniorities:       topNRecord(aggregatedStats.bySeniority),
      regions:           topNRecord(aggregatedStats.byRegion),
      software:          topNRecord(aggregatedStats.bySoftware),
      programmingSkills: topNRecord(aggregatedStats.byProgrammingSkill),
    },
    parquet: manifest.parquet ?? null,
  };

  // Avoid Reference: currentMonthStats is intentionally not used here directly
  // because aggregatedStats already includes it (computeAggregatedStats merges
  // every archive PLUS the current month). Kept in the input for callers that
  // want to log diffs or build alternate payloads.
  void currentMonthStats;

  // Short max-age — clients should always see the freshest aggregate on reload.
  // 60s matches the existing manifest.json / url-index.json cache headers.
  await r2.putJSON('stats/aggregate.json', payload, 'public, max-age=60');
  logger.info(
    `✓ Wrote stats/aggregate.json: ${totalJobs} jobs across ${manifest.availableMonths.length} months ` +
    `(parquet=${payload.parquet ? Object.keys(payload.parquet.daily).length + Object.keys(payload.parquet.monthly).length : 0} files)`
  );
}
