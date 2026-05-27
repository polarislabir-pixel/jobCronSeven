import { NextRequest, NextResponse } from 'next/server';
import { getAppliedJobsStorage, isAppliedNamespace } from '@/lib/applied-jobs-r2';
import { logger } from '@/lib/logger';

/**
 * Get all applied jobs
 *
 * Query params:
 * - month: Optional YYYY-MM to filter by month
 * - namespace: "default" (main) or "aryan". Defaults to "default".
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const month = searchParams.get('month') || undefined;
  const nsParam = searchParams.get('namespace');
  const namespace = isAppliedNamespace(nsParam) ? nsParam : 'default';

  try {
    const storage = getAppliedJobsStorage(namespace);
    await storage.load();

    const [applications, stats] = await Promise.all([
      storage.getApplications(month),
      storage.getStats(),
    ]);

    return NextResponse.json({
      success: true,
      data: applications,
      stats,
      filter: { month, namespace },
    });
  } catch (error) {
    logger.error('Failed to fetch applied jobs:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch applied jobs',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
