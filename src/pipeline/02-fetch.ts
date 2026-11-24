import pLimit from 'p-limit';
import type { SiteConfig, ManifestItem } from '../config.js';
import { WorkspaceFS } from '../core/fs.js';

export class FetchPipeline {
  constructor(
    private config: SiteConfig,
    private fs: WorkspaceFS = new WorkspaceFS()
  ) {}

  async run(options: { force?: boolean } = {}): Promise<{ total: number; fetched: number; skipped: number; failed: number }> {
    const manifest = await this.fs.loadManifest(this.config.id);
    console.log(`[Fetch] Total items in manifest: ${manifest.length}`);
    console.log(`[Fetch] Mode: ${this.config.fetch.mode}, Concurrency: ${this.config.fetch.concurrency}, Delay: ${this.config.fetch.delayMs}ms`);

    let fetched = 0;
    let skipped = 0;
    let failed = 0;

    if (this.config.fetch.mode === 'browser') {
      const res = await this.fetchWithBrowser(manifest, options);
      fetched = res.fetched;
      skipped = res.skipped;
      failed = res.failed;
    } else {
      const res = await this.fetchWithHttp(manifest, options);
      fetched = res.fetched;
      skipped = res.skipped;
      failed = res.failed;
    }

    console.log(`[Fetch] Done. Fetched: ${fetched}, Skipped (cached): ${skipped}, Failed: ${failed}`);
    return { total: manifest.length, fetched, skipped, failed };
  }

  private async fetchWithHttp(
    manifest: ManifestItem[],
    options: { force?: boolean }
  ): Promise<{ fetched: number; skipped: number; failed: number }> {
    let fetched = 0;
    let skipped = 0;
    let failed = 0;

    const limit = pLimit(this.config.fetch.concurrency);
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    const tasks = manifest.map((item) =>
      limit(async () => {
        const exists = await this.fs.hasRawHtml(this.config.id, item.hash);
        if (exists && !options.force) {
          skipped++;
          return;
        }

        if (this.config.fetch.delayMs > 0) {
          await new Promise((r) => setTimeout(r, this.config.fetch.delayMs));
        }

        try {
          console.log(`[Fetch:http] [${item.index + 1}/${manifest.length}] Fetching ${item.url}`);
          const res = await fetch(item.url, { headers });
          if (!res.ok) {
            console.error(`[Fetch:http] Failed ${item.url}: HTTP ${res.status}`);
            failed++;
            return;
          }
          const html = await res.text();
          await this.fs.saveRawHtml(this.config.id, item.hash, html);
          fetched++;
        } catch (err: any) {
          console.error(`[Fetch:http] Network error fetching ${item.url}:`, err.message);
          failed++;
        }
      })
    );

    await Promise.all(tasks);
    return { fetched, skipped, failed };
  }

  private async fetchWithBrowser(
    manifest: ManifestItem[],
    options: { force?: boolean }
  ): Promise<{ fetched: number; skipped: number; failed: number }> {
    let playwright: any;
    try {
      playwright = await import('playwright');
    } catch {
      throw new Error(
        'Playwright is required for browser fetch mode. Please install it using "npm install playwright" and "npx playwright install chromium".'
      );
    }

    console.log('[Fetch:browser] Launching chromium browser...');
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    let fetched = 0;
    let skipped = 0;
    let failed = 0;

    const limit = pLimit(this.config.fetch.concurrency);

    try {
      const tasks = manifest.map((item) =>
        limit(async () => {
          const exists = await this.fs.hasRawHtml(this.config.id, item.hash);
          if (exists && !options.force) {
            skipped++;
            return;
          }

          if (this.config.fetch.delayMs > 0) {
            await new Promise((r) => setTimeout(r, this.config.fetch.delayMs));
          }

          console.log(`[Fetch:browser] [${item.index + 1}/${manifest.length}] Rendering ${item.url}`);
          const page = await context.newPage();

          try {
            await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            if (this.config.fetch.waitForSelector) {
              await page
                .waitForSelector(this.config.fetch.waitForSelector, { timeout: 15000 })
                .catch(() => {});
            } else {
              await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            }

            const html = await page.content();
            await this.fs.saveRawHtml(this.config.id, item.hash, html);
            fetched++;
          } catch (err: any) {
            console.error(`[Fetch:browser] Error loading ${item.url}:`, err.message);
            failed++;
          } finally {
            await page.close().catch(() => {});
          }
        })
      );

      await Promise.all(tasks);
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    return { fetched, skipped, failed };
  }
}
