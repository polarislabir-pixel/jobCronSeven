import { NextRequest, NextResponse } from 'next/server';
import { validateTrackingUrl, decodeJobData } from '@/lib/tracking-url';
import { getAppliedJobsStorage, isAppliedNamespace, type AppliedNamespace } from '@/lib/applied-jobs-r2';
import { logger } from '@/lib/logger';

/**
 * Check if the request is from a bot (Telegram link preview, etc.)
 */
function isBotRequest(userAgent: string | null): boolean {
  if (!userAgent) return false;

  const botPatterns = [
    'TelegramBot',
    'Telegram',
    'WhatsApp',
    'Slackbot',
    'Discordbot',
    'facebookexternalhit',
    'Twitterbot',
    'LinkedInBot',
    'bot',
    'crawler',
    'spider',
    'preview',
  ];

  const lowerUA = userAgent.toLowerCase();
  return botPatterns.some(pattern => lowerUA.includes(pattern.toLowerCase()));
}

/**
 * Tracking endpoint for job applications
 *
 * When a user clicks a tracking link in Telegram:
 * 1. Validates the URL signature
 * 2. Decodes the job data
 * 3. Stores the application in R2 (only for real user clicks, not bot previews)
 * 4. Redirects to the actual job URL
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const userAgent = request.headers.get('user-agent');

  const jobId = searchParams.get('j');
  const timestamp = searchParams.get('t');
  const signature = searchParams.get('s');
  const encodedData = searchParams.get('d');
  const nsParam = searchParams.get('n');

  // Validate required parameters
  if (!jobId || !timestamp || !signature || !encodedData) {
    logger.warn('Track: Missing required parameters');
    return NextResponse.json(
      { error: 'Invalid tracking URL - missing parameters' },
      { status: 400 }
    );
  }

  // Resolve namespace (default if absent). Reject unknown values.
  let namespace: AppliedNamespace = 'default';
  if (nsParam !== null) {
    if (!isAppliedNamespace(nsParam)) {
      logger.warn(`Track: Unknown namespace "${nsParam}"`);
      return NextResponse.json(
        { error: 'Invalid tracking URL - unknown namespace' },
        { status: 400 }
      );
    }
    namespace = nsParam;
  }

  // Validate signature
  const validation = validateTrackingUrl(jobId, timestamp, signature, namespace);
  if (!validation.valid) {
    logger.warn(`Track: Invalid signature - ${validation.error}`);
    return NextResponse.json(
      { error: validation.error || 'Invalid tracking URL' },
      { status: 403 }
    );
  }

  // Decode job data
  const jobData = decodeJobData(encodedData);
  if (!jobData) {
    logger.warn('Track: Failed to decode job data');
    return NextResponse.json(
      { error: 'Invalid tracking URL - corrupted data' },
      { status: 400 }
    );
  }

  // Check if this is a bot request (Telegram link preview, etc.)
  // If so, skip storing and just redirect
  if (isBotRequest(userAgent)) {
    logger.info(`Track: Ignoring bot request (${userAgent?.substring(0, 50)}...)`);
    return NextResponse.redirect(jobData.jobUrl, 302);
  }

  try {
    // Store the application (only for real user clicks)
    const storage = getAppliedJobsStorage(namespace);
    await storage.load();

    const application = await storage.addApplication(jobData);

    if (application) {
      // Save to R2
      await storage.save();
      logger.info(`Track [${namespace}]: Logged application for "${jobData.title}" at "${jobData.company}"`);
    } else {
      logger.info(`Track [${namespace}]: Already applied to "${jobData.title}" (duplicate click)`);
    }
  } catch (error) {
    // Log error but don't block the redirect
    logger.error('Track: Failed to save application:', error);
  }

  // Redirect to the actual job URL
  return NextResponse.redirect(jobData.jobUrl, 302);
}
