import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { parseHTML } from 'linkedom';
import type { SiteConfig, ManifestItem } from '../config.js';
import { normalizeUrl, getUrlHash, isUrlInScope, getBreadcrumbFromUrl } from '../core/url.js';
import { WorkspaceFS } from '../core/fs.js';

// Ensure proxy agent is active if module used independently
setGlobalDispatcher(new EnvHttpProxyAgent());

export class DiscoverPipeline {
  constructor(
    private config: SiteConfig,
    private fs: WorkspaceFS = new WorkspaceFS()
  ) {}

  async run(): Promise<ManifestItem[]> {
    console.log(`[Discover] Starting discovery for site: ${this.config.name} (${this.config.id})`);
    console.log(`[Discover] Strategy: ${this.config.discover.strategy}`);

    let items: ManifestItem[] = [];

    switch (this.config.discover.strategy) {
      case 'sidebar':
        items = await this.discoverSidebar();
        break;
      case 'next-chain':
        items = await this.discoverNextChain();
        break;
      case 'sitemap':
        items = await this.discoverSitemap();
        break;
      default:
        throw new Error(`Unknown discover strategy: ${(this.config.discover as any).strategy}`);
    }

    if (items.length === 0) {
      console.warn(`[Discover] Warning: No pages discovered! Check configuration scope and selectors.`);
    } else {
      console.log(`[Discover] Successfully discovered ${items.length} pages.`);
    }

    await this.fs.saveManifest(this.config.id, items);
    return items;
  }

  /**
   * Strategy 1: Sidebar traversal
   */
  private async discoverSidebar(): Promise<ManifestItem[]> {
    const entryUrl = normalizeUrl(this.config.entryUrl);
    console.log(`[Discover:sidebar] Fetching entry page: ${entryUrl}`);

    const html = await this.fetchHtml(entryUrl);
    const hash = getUrlHash(entryUrl);
    await this.fs.saveRawHtml(this.config.id, hash, html);

    const { document } = parseHTML(html);
    const selector = this.config.discover.sidebarSelector!;
    const sidebar = document.querySelector(selector);

    if (!sidebar) {
      throw new Error(`Sidebar element not found with selector: "${selector}" at ${entryUrl}`);
    }

    const items: ManifestItem[] = [];
    const visitedUrls = new Set<string>();

    const traverse = (node: any, breadcrumbs: string[]) => {
      if (!node || node.nodeType !== 1) return;

      const children = Array.from(node.children || []);
      let activeSectionTitle: string | null = null;

      for (const child of children as any[]) {
        const tagName = child.tagName?.toLowerCase();

        // Check if child is a heading / category label
        if (
          ['summary', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName) ||
          child.classList?.contains('heading') ||
          child.classList?.contains('menu__link--sublist') ||
          child.classList?.contains('sidebar-category') ||
          child.classList?.contains('category-title')
        ) {
          const text = child.textContent?.trim();
          if (text) {
            activeSectionTitle = text;
          }
          if (tagName === 'li' && child.classList?.contains('heading')) {
            continue;
          }
        }

        const childBreadcrumbs = activeSectionTitle && !breadcrumbs.includes(activeSectionTitle)
          ? [...breadcrumbs, activeSectionTitle]
          : [...breadcrumbs];

        // If child is an anchor
        if (tagName === 'a') {
          const href = child.getAttribute('href');
          if (href) {
            const absoluteUrl = normalizeUrl(href, entryUrl);
            if (isUrlInScope(absoluteUrl, this.config.scope) && !visitedUrls.has(absoluteUrl)) {
              visitedUrls.add(absoluteUrl);
              const linkText = child.textContent?.trim() || '';

              const pageBreadcrumb = childBreadcrumbs.length > 0
                ? [...childBreadcrumbs]
                : getBreadcrumbFromUrl(absoluteUrl, this.config.entryUrl);

              const depth = this.config.notebooklm.groupByDepth ?? 1;
              const moduleKey = pageBreadcrumb.slice(0, depth).join(' - ') || '默认模块';

              items.push({
                index: items.length,
                url: absoluteUrl,
                hash: getUrlHash(absoluteUrl),
                title: linkText || undefined,
                breadcrumb: pageBreadcrumb,
                moduleKey,
              });
            }
          }
        }

        // Check if <li> contains a label anchor/span and a nested <ul>
        if (tagName === 'li') {
          const directAnchor = child.querySelector(':scope > a, :scope > span');
          const nestedList = child.querySelector(':scope > ul, :scope > ol');
          if (directAnchor && nestedList) {
            const label = directAnchor.textContent?.trim();
            if (label && !childBreadcrumbs.includes(label)) {
              traverse(child, [...childBreadcrumbs, label]);
              continue;
            }
          }
        }

        // Recursively traverse other child containers
        traverse(child, childBreadcrumbs);
      }
    };

    traverse(sidebar, []);

    // Ensure entryUrl is included if in scope and wasn't captured
    if (isUrlInScope(entryUrl, this.config.scope) && !visitedUrls.has(entryUrl)) {
      items.unshift({
        index: 0,
        url: entryUrl,
        hash,
        title: document.querySelector('title')?.textContent?.trim() || 'Index',
        breadcrumb: getBreadcrumbFromUrl(entryUrl, entryUrl),
        moduleKey: 'Overview',
      });
      // Re-index
      items.forEach((item, idx) => {
        item.index = idx;
      });
    }

    return items;
  }

  /**
   * Strategy 2: Next-chain traversal
   */
  private async discoverNextChain(): Promise<ManifestItem[]> {
    const items: ManifestItem[] = [];
    const visited = new Set<string>();
    let currentUrl: string | null = normalizeUrl(this.config.entryUrl);
    const nextSelector = this.config.discover.nextSelector || 'a[rel="next"]';

    console.log(`[Discover:next-chain] Starting from ${currentUrl}`);

    while (currentUrl && !visited.has(currentUrl)) {
      if (!isUrlInScope(currentUrl, this.config.scope)) {
        console.log(`[Discover:next-chain] URL out of scope: ${currentUrl}, stopping chain.`);
        break;
      }

      visited.add(currentUrl);
      console.log(`[Discover:next-chain] Step ${items.length + 1}: ${currentUrl}`);

      const html = await this.fetchHtml(currentUrl);
      const hash = getUrlHash(currentUrl);
      // Cache raw HTML so Stage 2 reuses it without duplicate request
      await this.fs.saveRawHtml(this.config.id, hash, html);

      const { document } = parseHTML(html);

      // Extract title
      const title =
        document.querySelector('h1')?.textContent?.trim() ||
        document.querySelector('title')?.textContent?.trim();

      // Extract breadcrumbs
      let breadcrumb: string[] = [];
      const extractBreadcrumbs = (container: any): string[] => {
        if (!container) return [];
        const lis = Array.from(container.querySelectorAll('li'));
        if (lis.length > 0) {
          return lis.map((el: any) => el.textContent?.trim()).filter(Boolean);
        }
        const links = Array.from(container.querySelectorAll('a, span'))
          .map((el: any) => el.textContent?.trim())
          .filter((t): t is string => Boolean(t) && t !== '>' && t !== '/' && t !== '»');
        return Array.from(new Set(links));
      };

      if (this.config.discover.breadcrumbSelector) {
        const bcEl = document.querySelector(this.config.discover.breadcrumbSelector);
        breadcrumb = extractBreadcrumbs(bcEl);
      }

      if (breadcrumb.length === 0) {
        const semanticBc = document.querySelector('nav[aria-label*="breadcrumb" i], .breadcrumb, [class*="breadcrumb"]');
        breadcrumb = extractBreadcrumbs(semanticBc);
      }

      if (breadcrumb.length === 0) {
        breadcrumb = getBreadcrumbFromUrl(currentUrl, this.config.entryUrl);
      }

      const depth = this.config.notebooklm.groupByDepth ?? 1;
      const moduleKey = breadcrumb.slice(0, depth).join(' - ') || '默认模块';

      items.push({
        index: items.length,
        url: currentUrl,
        hash,
        title: title || undefined,
        breadcrumb,
        moduleKey,
      });

      // Find next link
      let nextLink: any = document.querySelector(nextSelector);
      if (!nextLink) {
        // Fallback: look for <a> with text containing Next or 下一页
        const allAnchors = Array.from(document.querySelectorAll('a'));
        nextLink = allAnchors.find((a: any) => {
          const rel = a.getAttribute('rel')?.toLowerCase();
          if (rel === 'next') return true;
          const text = (a.textContent || '').trim().toLowerCase();
          return (
            text.includes('next') ||
            text.includes('下一页') ||
            text.includes('下一篇') ||
            (a.className && /pagination.*next/i.test(a.className))
          );
        });
      }

      if (nextLink && nextLink.getAttribute('href')) {
        const nextHref = nextLink.getAttribute('href');
        const nextResolved = normalizeUrl(nextHref, currentUrl);
        if (!visited.has(nextResolved)) {
          currentUrl = nextResolved;
          // Apply configured delay
          if (this.config.fetch.delayMs) {
            await new Promise((r) => setTimeout(r, this.config.fetch.delayMs));
          }
        } else {
          currentUrl = null;
        }
      } else {
        currentUrl = null;
      }
    }

    return items;
  }

  /**
   * Strategy 3: Sitemap traversal
   */
  private async discoverSitemap(): Promise<ManifestItem[]> {
    let sitemapUrl = this.config.discover.sitemapUrl;
    if (!sitemapUrl) {
      const entryObj = new URL(this.config.entryUrl);
      sitemapUrl = `${entryObj.origin}/sitemap.xml`;
    }

    console.log(`[Discover:sitemap] Fetching sitemap: ${sitemapUrl}`);
    const xml = await this.fetchHtml(sitemapUrl);
    const urls = this.extractUrlsFromSitemap(xml);

    console.log(`[Discover:sitemap] Found ${urls.length} total URLs in sitemap`);

    // Filter by scope
    const inScopeUrls = urls.filter((url) => isUrlInScope(url, this.config.scope));
    console.log(`[Discover:sitemap] ${inScopeUrls.length} URLs in scope`);

    // Sort lexicographically by pathname
    inScopeUrls.sort((a, b) => {
      const pathA = new URL(a).pathname;
      const pathB = new URL(b).pathname;
      return pathA.localeCompare(pathB);
    });

    const depth = this.config.notebooklm.groupByDepth ?? 1;

    return inScopeUrls.map((url, index) => {
      const breadcrumb = getBreadcrumbFromUrl(url, this.config.entryUrl);
      const moduleKey = breadcrumb.slice(0, depth).join(' - ') || '默认模块';
      return {
        index,
        url,
        hash: getUrlHash(url),
        breadcrumb,
        moduleKey,
      };
    });
  }

  private extractUrlsFromSitemap(xml: string): string[] {
    const locMatches = xml.match(/<loc>\s*([^<]+?)\s*<\/loc>/gi);
    if (!locMatches) return [];

    const urls: string[] = [];
    for (const match of locMatches) {
      const content = match.replace(/<\/?loc>/gi, '').trim();
      if (content) {
        urls.push(normalizeUrl(content));
      }
    }
    return Array.from(new Set(urls));
  }

  private async fetchHtml(url: string): Promise<string> {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    };

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
    }
    return res.text();
  }
}
