import { JobItem } from "@/types/job";
import { extractJobDetails, analyzeJobDescription } from "./job-analyzer";
import { createTrackingUrl } from "./tracking-url";
import type { AppliedNamespace } from "./applied-jobs-r2";
import { JobMetadataExtractor } from "./job-metadata-extractor";
import { LocationExtractor } from "./location-extractor";
import { RoleTypeExtractor } from "./role-type-extractor";
import { softwareKeywords } from "./dictionaries/software";
import { programmingKeywords } from "./dictionaries/programming-languages";

/**
 * Extracts the main domain name from a URL
 * e.g. "https://www.linkedin.com/jobs/view/123" → "linkedin.com"
 */
function extractSourceDomain(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Calculates time elapsed since job posting
 */
function getTimeAgo(postDate: Date): string {
  const now = new Date();
  const totalMinutes = Math.floor((now.getTime() - postDate.getTime()) / 60000);

  if (totalMinutes < 1) {
    return "Just now";
  } else if (totalMinutes < 60) {
    return `${totalMinutes} min${totalMinutes > 1 ? 's' : ''} ago`;
  } else if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ago`;
  } else {
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    return `${days}d ${hours}h ago`;
  }
}

/**
 * Formats a date for display
 */
function formatDate(date: Date): string {
  const dateStr = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

  const timeStr = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  });

  return `${dateStr} at ${timeStr}`;
}

/**
 * Formats a job item as a Telegram message.
 * `options.namespace` controls which applied-jobs store the tracking link writes into.
 */
export function formatJobMessage(
  job: JobItem,
  options: { namespace?: AppliedNamespace } = {},
): string {
  const details = extractJobDetails(job.title);
  const postDate = new Date(job.pubDate);
  const timeAgo = getTimeAgo(postDate);

  // Comprehensive metadata extraction (same modules as stats project)
  const metadata = JobMetadataExtractor.extractAllMetadata({
    title: details.position,
    company: details.company !== 'N/A' ? details.company : (job.company || ''),
    description: job.description,
    url: job.link,
  });

  // Structured location extraction with country/city breakdown
  const rawLocation = details.location !== 'N/A' ? details.location : (job.location || '');
  const locationData = LocationExtractor.extractLocation(
    rawLocation,
    job.link,
    job.title,
    job.description,
  );
  const locationDisplay = rawLocation || LocationExtractor.formatLocation(locationData) || 'N/A';

  // Experience, key skills, and academic degrees from job analyzer
  const analysis = analyzeJobDescription(job.description);

  // Role type and category using the same comprehensive extractor as stats
  const roleTypeMatch = RoleTypeExtractor.extractRoleType(
    details.position,
    metadata.keywords,
    job.description,
    metadata.industry,
  );

  // Validate yearsExperience — discard unrealistically large values (>15 years)
  let validatedExperience: string | null = null;
  if (analysis.yearsExperience) {
    const yearsMatch = analysis.yearsExperience.match(/(\d+)/);
    if (yearsMatch && parseInt(yearsMatch[1], 10) <= 15) {
      validatedExperience = analysis.yearsExperience;
    }
  }

  // Extract software and programming skills directly from dictionaries (comprehensive)
  const software: string[] = [];
  for (const [soft, pattern] of Object.entries(softwareKeywords)) {
    if (pattern.test(job.description)) {
      software.push(soft);
    }
    pattern.lastIndex = 0;
  }

  const programmingSkills: string[] = [];
  for (const [skill, pattern] of Object.entries(programmingKeywords)) {
    if (pattern.test(job.description)) {
      programmingSkills.push(skill);
    }
    pattern.lastIndex = 0;
  }

  const source = extractSourceDomain(job.link);

  const sections: string[] = [
    "🆕 NEW JOB POSTING",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `📋 Position: ${details.position}`,
    "",
    `🏢 Company: ${details.company}`,
  ];

  if (metadata.industry && metadata.industry !== 'Other') {
    sections.push(`🏦 Industry: ${metadata.industry}`);
  }

  sections.push(`📈 Seniority: ${metadata.seniority}`);

  sections.push("", `📍 Location: ${locationDisplay}`);
  if (locationData.country) sections.push(`🌍 Country: ${locationData.country}`);
  if (locationData.city) sections.push(`🏙️ City: ${locationData.city}`);

  if (roleTypeMatch?.category) {
    sections.push(`🗂️ Category: ${roleTypeMatch.category}`);
  }
  if (roleTypeMatch?.roleType) {
    sections.push(`💼 Role Type: ${roleTypeMatch.roleType}`);
  }

  if (validatedExperience) {
    sections.push(`📊 Experience: ${validatedExperience}`);
  }

  if (metadata.certificates.length > 0) {
    sections.push(`🎓 Certifications: ${metadata.certificates.join(', ')}`);
  }

  if (analysis.academicDegrees.length > 0) {
    sections.push(`🎓 Education: ${analysis.academicDegrees.join(', ')}`);
  }

  if (analysis.expertise.length > 0) {
    sections.push("", "🔧 Key Skills:");
    analysis.expertise.forEach(skill => {
      sections.push(`   • ${skill}`);
    });
  }

  if (programmingSkills.length > 0) {
    sections.push(`💻 Programming: ${programmingSkills.join(', ')}`);
  }

  if (software.length > 0) {
    sections.push(`🖥️ Software: ${software.slice(0, 5).join(', ')}`);
  }

  // For Indeed jobs, rewrite the tracking param so the direct link works
  let jobUrl = job.link.toLowerCase().includes('indeed')
    ? job.link.replace('from=social_other', 'from=jobsearch-empty-whatwhere')
    : job.link;

  // Strip HTML-encoded ampersands from Indeed URLs
  if (jobUrl.toLowerCase().includes('indeed')) {
    jobUrl = jobUrl.replace(/amp;/g, '');
  }

  // Generate tracking URL with job metadata (namespaced per pipeline)
  const trackingUrl = createTrackingUrl(
    {
      jobUrl,
      title: details.position,
      company: details.company,
      location: locationDisplay,
      postedDate: job.pubDate,
      roleType: roleTypeMatch?.roleType ?? undefined,
      industry: metadata.industry !== 'Other' ? metadata.industry : undefined,
    },
    { namespace: options.namespace },
  );

  sections.push(
    "",
    `🌐 Source: ${source}`,
    `⏰ Posted: ${timeAgo}`,
    `📅 ${formatDate(postDate)}`,
    "",
    "🔗 Apply here:",
    trackingUrl,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "💼 LinkedIn Jobs Monitor"
  );

  return sections.join('\n');
}
