import { z } from 'zod';

export const SiteConfigSchema = z.object({
  id: z.string().min(1, 'Site ID is required'),
  name: z.string().min(1, 'Site Name is required'),
  entryUrl: z.string().url('entryUrl must be a valid URL'),
  discover: z.object({
    strategy: z.enum(['sidebar', 'next-chain', 'sitemap']),
    sidebarSelector: z.string().optional(),
    nextSelector: z.string().default('a[rel="next"]'),
    breadcrumbSelector: z.string().optional(),
    sitemapUrl: z.string().url().optional(),
  }).refine((data) => {
    if (data.strategy === 'sidebar' && !data.sidebarSelector) {
      return false;
    }
    return true;
  }, {
    message: 'sidebarSelector is required when discover strategy is "sidebar"',
    path: ['sidebarSelector'],
  }),
  scope: z.object({
    allowPrefixes: z.array(z.string()).min(1, 'At least one allowPrefix is required'),
    excludePatterns: z.array(z.string()).default([]),
  }),
  fetch: z.object({
    mode: z.enum(['http', 'browser']).default('http'),
    concurrency: z.number().int().positive().optional(),
    delayMs: z.number().int().nonnegative().default(200),
    waitForSelector: z.string().optional(),
  }).default({}).transform((val) => ({
    ...val,
    concurrency: val.concurrency ?? (val.mode === 'browser' ? 2 : 5),
  })),
  notebooklm: z.object({
    groupByDepth: z.number().int().min(1).default(1),
    targetMaxFiles: z.number().int().positive().default(25),
    maxWordsPerFile: z.number().int().positive().default(120000),
    minWordsToMerge: z.number().int().nonnegative().default(3000),
    keepExternalImages: z.boolean().default(true),
  }).default({}),
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;

export interface ManifestItem {
  index: number;
  url: string;
  hash: string;
  title?: string;
  breadcrumb: string[];
  moduleKey: string;
}

export interface ExtractedPage extends ManifestItem {
  finalTitle: string;
  description?: string;
  prevTitle?: string;
  nextTitle?: string;
  headings: Array<{ level: number; text: string }>;
  wordCount: number;
  mdFilePath: string;
  status: 'ok' | 'empty' | 'error';
  errorMessage?: string;
}

export interface QualityReport {
  siteId: string;
  siteName: string;
  generatedAt: string;
  emptyOrTinyPages: Array<{ url: string; title: string; wordCount: number }>;
  oversizedPages: Array<{ url: string; title: string; wordCount: number }>;
  failedPages: Array<{ url: string; error?: string }>;
  bundleSummary: {
    totalFiles: number;
    totalWords: number;
    maxWordsInSingleFile: number;
    files: Array<{
      filename: string;
      title: string;
      pageCount: number;
      wordCount: number;
      chapters: string[];
    }>;
  };
}

export function parseSiteConfig(rawJson: unknown): SiteConfig {
  return SiteConfigSchema.parse(rawJson);
}
