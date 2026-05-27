import crypto from 'crypto';
import { TrackingJobData } from '@/types/applied-job';
import type { AppliedNamespace } from './applied-jobs-r2';

const TRACKING_SECRET = process.env.TRACKING_SECRET || 'default-dev-secret-change-in-production';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

/**
 * Creates an HMAC signature for tracking URL validation.
 * Namespace is included so a default-namespace link can't be replayed as aryan.
 * An empty namespace string is treated as "default" so previously issued URLs
 * (which don't carry an `n` param) still validate.
 */
function createSignature(jobId: string, timestamp: number, namespace: string = ''): string {
  return crypto
    .createHmac('sha256', TRACKING_SECRET)
    .update(`${jobId}:${timestamp}:${namespace}`)
    .digest('base64url')
    .substring(0, 16); // Truncate for shorter URLs
}

/**
 * Generates a job ID from the URL (hash)
 */
export function generateJobId(url: string): string {
  return crypto
    .createHash('md5')
    .update(url)
    .digest('hex')
    .substring(0, 12);
}

/**
 * Encodes job data to base64url for URL transport
 */
function encodeJobData(data: TrackingJobData): string {
  const json = JSON.stringify({
    u: data.jobUrl,
    t: data.title,
    c: data.company,
    l: data.location,
    p: data.postedDate,
    r: data.roleType || '',
    i: data.industry || '',
  });
  return Buffer.from(json).toString('base64url');
}

/**
 * Decodes job data from base64url
 */
export function decodeJobData(encoded: string): TrackingJobData | null {
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf-8');
    const data = JSON.parse(json);
    return {
      jobUrl: data.u,
      title: data.t,
      company: data.c,
      location: data.l,
      postedDate: data.p,
      roleType: data.r || undefined,
      industry: data.i || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Creates a tracking URL for a job posting
 *
 * URL Format: /api/track?j=<jobId>&t=<timestamp>&s=<signature>&d=<encodedData>[&n=<namespace>]
 * `n` is only emitted for non-default namespaces so default URLs are unchanged.
 */
export function createTrackingUrl(
  jobData: TrackingJobData,
  options: { namespace?: AppliedNamespace } = {},
): string {
  const namespace = options.namespace ?? 'default';
  const jobId = generateJobId(jobData.jobUrl);
  const timestamp = Date.now();
  const signature = createSignature(jobId, timestamp, namespace === 'default' ? '' : namespace);
  const encodedData = encodeJobData(jobData);

  const params = new URLSearchParams({
    j: jobId,
    t: timestamp.toString(),
    s: signature,
    d: encodedData,
  });
  if (namespace !== 'default') {
    params.set('n', namespace);
  }

  return `${APP_BASE_URL}/api/track?${params.toString()}`;
}

/**
 * Validates a tracking URL's signature.
 * For default namespace, also accepts the legacy signature format (no namespace suffix)
 * so URLs issued before the namespace feature continue to work.
 */
export function validateTrackingUrl(
  jobId: string,
  timestamp: string,
  signature: string,
  namespace: AppliedNamespace = 'default',
): { valid: boolean; error?: string } {
  // Validate timestamp format
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return { valid: false, error: 'Invalid timestamp' };
  }

  // Optional: Check if URL is expired (e.g., 30 days)
  const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  if (Date.now() - ts > maxAge) {
    return { valid: false, error: 'Tracking URL expired' };
  }

  const candidates: string[] = [
    createSignature(jobId, ts, namespace === 'default' ? '' : namespace),
  ];
  // Legacy format (no namespace component) — only valid for the default namespace.
  if (namespace === 'default') {
    candidates.push(
      crypto
        .createHmac('sha256', TRACKING_SECRET)
        .update(`${jobId}:${ts}`)
        .digest('base64url')
        .substring(0, 16),
    );
  }

  for (const expected of candidates) {
    try {
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { valid: true };
      }
    } catch {
      // try next candidate
    }
  }

  return { valid: false, error: 'Invalid signature' };
}
