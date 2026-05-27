import { NextRequest, NextResponse } from 'next/server';
import { getR2Storage } from '@/lib/r2-storage';
import { logger } from '@/lib/logger';
import { AppliedJob, AppliedJobsManifest } from '@/types/applied-job';
import { LocationExtractor, normalizeCity } from '@/lib/location-extractor';
import { isAppliedNamespace, getAppliedPrefix } from '@/lib/applied-jobs-r2';

/**
 * Re-normalize location data for all existing applied jobs in R2
 *
 * POST /api/applied/normalize?namespace=default|aryan
 */
export async function POST(request: NextRequest) {
  const nsParam = request.nextUrl.searchParams.get('namespace');
  const namespace = isAppliedNamespace(nsParam) ? nsParam : 'default';
  const prefix = getAppliedPrefix(namespace);

  try {
    const r2 = getR2Storage();

    if (!r2.isAvailable()) {
      return NextResponse.json(
        { success: false, error: 'R2 storage not available' },
        { status: 503 }
      );
    }

    // Load manifest
    const manifest = await r2.getJSON<AppliedJobsManifest>(`${prefix}/manifest.json`);

    if (!manifest || Object.keys(manifest.applicationsByMonth).length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No applications to normalize',
        updated: 0,
      });
    }

    let totalUpdated = 0;
    const updatedMonths: string[] = [];

    // Process each month's data
    for (const month of Object.keys(manifest.applicationsByMonth)) {
      const key = `${prefix}/${month}.ndjson.gz`;

      try {
        const applications = await r2.getNDJSONGzipped<AppliedJob>(key);

        if (applications.length === 0) continue;

        // Re-normalize each application
        const updatedApps = applications.map((app) => {
          const locationData = LocationExtractor.extractLocation(
            app.location,
            app.originalUrl,
            null,
            ''
          );
          const normalizedCity = normalizeCity(locationData.city);

          return {
            ...app,
            city: normalizedCity || undefined,
            country: locationData.country || undefined,
            region: locationData.region || undefined,
          };
        });

        // Save updated data back to R2
        await r2.putNDJSONGzipped(key, updatedApps);

        totalUpdated += updatedApps.length;
        updatedMonths.push(month);

        logger.info(`Normalized ${updatedApps.length} applications for ${month} [${namespace}]`);
      } catch (error) {
        logger.warn(`Failed to process ${month}:`, error);
      }
    }

    logger.info(`Location normalization complete [${namespace}]: ${totalUpdated} applications updated`);

    return NextResponse.json({
      success: true,
      namespace,
      message: `Normalized ${totalUpdated} applications`,
      updatedMonths,
      totalUpdated,
    });
  } catch (error) {
    logger.error('Failed to normalize applied jobs:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to normalize applied jobs',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
