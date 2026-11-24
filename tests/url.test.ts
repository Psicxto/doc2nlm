import { describe, it, expect } from 'vitest';
import { normalizeUrl, getUrlHash, isUrlInScope, getBreadcrumbFromUrl } from '../src/core/url.js';

describe('core/url', () => {
  it('normalizes URLs properly', () => {
    // Strips hash
    expect(normalizeUrl('https://example.com/docs#section')).toBe('https://example.com/docs');

    // Strips tracking parameters
    expect(
      normalizeUrl('https://example.com/docs?utm_source=google&page=1&ref=twitter')
    ).toBe('https://example.com/docs?page=1');

    // Normalizes trailing slashes (except root)
    expect(normalizeUrl('https://example.com/docs/intro/')).toBe('https://example.com/docs/intro');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');

    // Resolves relative URLs
    expect(normalizeUrl('../guide', 'https://example.com/docs/intro')).toBe('https://example.com/guide');
  });

  it('generates consistent 10-char sha1 hash', () => {
    const hash1 = getUrlHash('https://example.com/docs/intro');
    const hash2 = getUrlHash('https://example.com/docs/intro');
    const hash3 = getUrlHash('https://example.com/docs/other');

    expect(hash1).toHaveLength(10);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('checks scope with allowPrefixes and excludePatterns', () => {
    const scope = {
      allowPrefixes: ['https://caddyserver.com/docs/'],
      excludePatterns: ['/api/', '/changelog/'],
    };

    // Allowed
    expect(isUrlInScope('https://caddyserver.com/docs/quick-starts', scope)).toBe(true);
    expect(isUrlInScope('https://caddyserver.com/docs/', scope)).toBe(true);

    // Excluded by allowPrefixes
    expect(isUrlInScope('https://caddyserver.com/blog/v2', scope)).toBe(false);
    expect(isUrlInScope('https://other.com/docs', scope)).toBe(false);

    // Excluded by excludePatterns
    expect(isUrlInScope('https://caddyserver.com/docs/api/v1', scope)).toBe(false);
    expect(isUrlInScope('https://caddyserver.com/docs/changelog', scope)).toBe(false);
  });

  it('generates breadcrumbs from URL pathname', () => {
    const bc = getBreadcrumbFromUrl(
      'https://example.com/docs/guide/performance/memory-cache',
      'https://example.com/docs/'
    );
    expect(bc).toEqual(['Guide', 'Performance', 'Memory cache']);
  });
});
