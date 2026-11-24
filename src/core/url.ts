import crypto from 'node:crypto';

/**
 * Standardize and normalize a URL:
 * - Resolve relative URL against base
 * - Strip hash fragment
 * - Remove tracking / marketing query parameters
 * - Normalize trailing slashes (strip trailing slash unless path is "/")
 */
export function normalizeUrl(rawUrl: string, baseUrl?: string): string {
  try {
    const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    parsed.hash = '';

    // Remove tracking query parameters
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'ref',
      'source',
      'spm',
      'fbclid',
      'gclid',
      '_ga',
      '_gl',
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    // Sort search parameters for consistency
    parsed.searchParams.sort();

    // Standardize trailing slash: remove trailing slash if pathname ends with "/" (and not root "/")
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Computes sha1(url).slice(0, 10) for disk cache filenames
 */
export function getUrlHash(url: string): string {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
}

/**
 * Checks whether a URL is within the configured scope:
 * - Must start with at least one allowPrefixes
 * - Must NOT match any excludePatterns (regular expressions)
 */
export function isUrlInScope(
  url: string,
  scope: { allowPrefixes: string[]; excludePatterns?: string[] }
): boolean {
  const normalized = normalizeUrl(url);

  // Check allow prefixes
  const matchesPrefix = scope.allowPrefixes.some((prefix) => {
    const normalizedPrefix = normalizeUrl(prefix);
    return normalized === normalizedPrefix || normalized.startsWith(normalizedPrefix + '/') || normalized.startsWith(normalizedPrefix + '?') || normalized.startsWith(prefix);
  });

  if (!matchesPrefix) {
    return false;
  }

  // Check exclude patterns
  if (scope.excludePatterns && scope.excludePatterns.length > 0) {
    for (const pattern of scope.excludePatterns) {
      try {
        // If pattern has trailing slash (e.g. /changelog/), match either /changelog/ or /changelog at the end of path
        const regexStr = pattern.endsWith('/')
          ? pattern.slice(0, -1) + '(/|$)'
          : pattern;
        const regex = new RegExp(regexStr);
        if (regex.test(normalized)) {
          return false;
        }
      } catch {
        // If regex fails, fallback to simple string check
        const cleanPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
        if (normalized.includes(cleanPattern)) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Fallback breadcrumb generation from URL path segments
 */
export function getBreadcrumbFromUrl(url: string, baseEntryUrl?: string): string[] {
  try {
    const parsed = new URL(url);
    let pathname = parsed.pathname;

    if (baseEntryUrl) {
      try {
        const basePath = new URL(baseEntryUrl).pathname;
        if (pathname.startsWith(basePath)) {
          pathname = pathname.slice(basePath.length);
        }
      } catch {
        // Ignore
      }
    }

    const segments = pathname
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // Clean segment: replace hyphens/underscores with space and capitalize
        const cleaned = s.replace(/[-_]+/g, ' ');
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
      });

    return segments.length > 0 ? segments : ['General'];
  } catch {
    return ['General'];
  }
}
