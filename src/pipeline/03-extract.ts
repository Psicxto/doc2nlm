import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import type { SiteConfig, ManifestItem, ExtractedPage } from '../config.js';
import { extractHeadings, estimateWordCount } from '../core/markdown.js';
import { WorkspaceFS } from '../core/fs.js';

export class ExtractPipeline {
  constructor(
    private config: SiteConfig,
    private fs: WorkspaceFS = new WorkspaceFS()
  ) {}

  /**
   * Extension hook for future post-processing.
   * V1 returns markdown untouched.
   */
  postProcessMarkdown(
    markdown: string,
    _ctx: { item: ManifestItem; config: SiteConfig }
  ): string {
    return markdown;
  }

  async run(): Promise<ExtractedPage[]> {
    const manifest = await this.fs.loadManifest(this.config.id);
    console.log(`[Extract] Starting offline extraction for ${manifest.length} pages...`);

    const extractedPages: ExtractedPage[] = [];

    for (let i = 0; i < manifest.length; i++) {
      const item = manifest[i];
      console.log(`[Extract] [${i + 1}/${manifest.length}] Extracting ${item.url}`);

      const hasHtml = await this.fs.hasRawHtml(this.config.id, item.hash);
      if (!hasHtml) {
        console.warn(`[Extract] Missing raw HTML for ${item.url} (hash: ${item.hash})`);
        extractedPages.push({
          ...item,
          finalTitle: item.title || 'Untitled',
          headings: [],
          wordCount: 0,
          mdFilePath: '',
          status: 'error',
          errorMessage: 'Raw HTML file missing',
        });
        continue;
      }

      try {
        const rawHtml = await this.fs.loadRawHtml(this.config.id, item.hash);
        const { document } = parseHTML(rawHtml);

        // 1. Enrich breadcrumb if not present
        let breadcrumb = [...item.breadcrumb];
        if (breadcrumb.length === 0 && this.config.discover.breadcrumbSelector) {
          const bcEl = document.querySelector(this.config.discover.breadcrumbSelector);
          if (bcEl) {
            const lis = Array.from(bcEl.querySelectorAll('li'));
            if (lis.length > 0) {
              breadcrumb = lis.map((el: any) => el.textContent?.trim()).filter(Boolean);
            } else {
              const links = Array.from(bcEl.querySelectorAll('a, span'))
                .map((el: any) => el.textContent?.trim())
                .filter((t): t is string => Boolean(t) && t !== '>' && t !== '/' && t !== '»');
              breadcrumb = Array.from(new Set(links));
            }
          }
        }

        // 2. Sniff prevTitle / nextTitle
        let prevTitle = manifest[i - 1]?.title;
        let nextTitle = manifest[i + 1]?.title;

        const prevEl = document.querySelector('a[rel="prev"], .pagination-prev, [class*="pagination__link--prev"]');
        if (prevEl?.textContent?.trim()) {
          prevTitle = prevEl.textContent.trim().replace(/^«?\s*上一页\s*:?\s*/i, '').replace(/^«?\s*Previous\s*:?\s*/i, '');
        }

        const nextEl = document.querySelector('a[rel="next"], .pagination-next, [class*="pagination__link--next"]');
        if (nextEl?.textContent?.trim()) {
          nextTitle = nextEl.textContent.trim().replace(/^下一页\s*:?\s*»?/i, '').replace(/^Next\s*:?\s*»?/i, '');
        }

        // 3. Blackbox call Defuddle
        const defuddleResult = await Defuddle(document, item.url, {
          markdown: true,
          removeImages: !this.config.notebooklm.keepExternalImages,
        });

        let md = defuddleResult.content || '';
        md = this.postProcessMarkdown(md, { item, config: this.config });

        // 4. Extract headings & word count
        const headings = extractHeadings(md);
        const wordCount = estimateWordCount(md);

        const pageH1 = document.querySelector('article h1, main h1, .docs-content h1, h1')?.textContent?.trim();
        const cleanDocTitle = document.querySelector('title')?.textContent?.trim()?.replace(/\s*[—\-|].*$/, '');

        const finalTitle =
          pageH1 ||
          item.title ||
          defuddleResult.title ||
          cleanDocTitle ||
          'Untitled';

        // 5. Save markdown
        const mdFilePath = await this.fs.savePageMd(this.config.id, item.hash, md);

        const status: 'ok' | 'empty' | 'error' = wordCount < 10 ? 'empty' : 'ok';

        extractedPages.push({
          ...item,
          breadcrumb,
          finalTitle,
          description: defuddleResult.description || undefined,
          prevTitle: prevTitle || undefined,
          nextTitle: nextTitle || undefined,
          headings,
          wordCount,
          mdFilePath,
          status,
        });
      } catch (err: any) {
        console.error(`[Extract] Error processing ${item.url}:`, err.message);
        extractedPages.push({
          ...item,
          finalTitle: item.title || 'Untitled',
          headings: [],
          wordCount: 0,
          mdFilePath: '',
          status: 'error',
          errorMessage: err.message || 'Defuddle extraction failed',
        });
      }
    }

    await this.fs.saveExtracted(this.config.id, extractedPages);
    console.log(`[Extract] Extraction completed for ${extractedPages.length} pages.`);
    return extractedPages;
  }
}
