import { NextRequest, NextResponse } from 'next/server';
import { getAppliedJobsStorage, isAppliedNamespace } from '@/lib/applied-jobs-r2';
import { logger } from '@/lib/logger';

/**
 * Clear all applied jobs data from R2
 *
 * POST /api/applied/clear?namespace=default|aryan
 */
export async function POST(request: NextRequest) {
  const nsParam = request.nextUrl.searchParams.get('namespace');
  const namespace = isAppliedNamespace(nsParam) ? nsParam : 'default';

  try {
    const storage = getAppliedJobsStorage(namespace);
    await storage.load();

    const result = await storage.clearAll();

    logger.info(`Cleared applied jobs [${namespace}]: ${result.totalDeleted} jobs from ${result.deletedMonths.length} months`);

    return NextResponse.json({
      success: true,
      namespace,
      message: `Cleared ${result.totalDeleted} applied jobs`,
      deletedMonths: result.deletedMonths,
      totalDeleted: result.totalDeleted,
    });
  } catch (error) {
    logger.error('Failed to clear applied jobs:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to clear applied jobs',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
