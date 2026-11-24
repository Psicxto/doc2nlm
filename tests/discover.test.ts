import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSiteConfig } from '../src/config.js';
import { WorkspaceFS } from '../src/core/fs.js';
import { DiscoverPipeline } from '../src/pipeline/01-discover.js';

const testWorkspaceDir = path.resolve('workspace-test-discover');

describe('DiscoverPipeline strategies', () => {
  const fsInstance = new WorkspaceFS(testWorkspaceDir);

  beforeEach(async () => {
    await fsInstance.ensureSiteDirs('test-site');
  });

  afterEach(async () => {
    await fs.rm(testWorkspaceDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it('discovers pages via sidebar strategy with nested sections and breadcrumbs', async () => {
    const sidebarHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Docs Home</title></head>
      <body>
        <nav class="sidebar">
          <div class="category">
            <h3>Quick Start</h3>
            <ul>
              <li><a href="/docs/install">Installation</a></li>
              <li><a href="/docs/first-app">Your First App</a></li>
            </ul>
          </div>
          <div class="category">
            <h3>Configuration</h3>
            <ul>
              <li><a href="/docs/config/basic">Basic Config</a></li>
              <li><a href="/docs/api/ignored">API Reference (Excluded)</a></li>
            </ul>
          </div>
        </nav>
      </body>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => sidebarHtml,
    } as any);

    const config = parseSiteConfig({
      id: 'test-site',
      name: 'Test Site',
      entryUrl: 'https://docs.local/docs/intro',
      discover: {
        strategy: 'sidebar',
        sidebarSelector: 'nav.sidebar',
      },
      scope: {
        allowPrefixes: ['https://docs.local/docs/'],
        excludePatterns: ['/api/'],
      },
      notebooklm: {
        groupByDepth: 1,
      },
    });

    const discover = new DiscoverPipeline(config, fsInstance);
    const manifest = await discover.run();

    // /docs/api/ignored should be excluded by excludePatterns
    expect(manifest.some((item) => item.url.includes('/api/'))).toBe(false);

    // /docs/install and /docs/first-app should be discovered under "Quick Start"
    const installItem = manifest.find((item) => item.url.includes('/docs/install'));
    expect(installItem).toBeDefined();
    expect(installItem?.title).toBe('Installation');
    expect(installItem?.breadcrumb).toEqual(['Quick Start']);
    expect(installItem?.moduleKey).toBe('Quick Start');

    // /docs/config/basic under "Configuration"
    const configItem = manifest.find((item) => item.url.includes('/docs/config/basic'));
    expect(configItem).toBeDefined();
    expect(configItem?.breadcrumb).toEqual(['Configuration']);
    expect(configItem?.moduleKey).toBe('Configuration');
  });

  it('discovers pages via next-chain strategy', async () => {
    const page1Html = `
      <html>
      <head><title>Page 1</title></head>
      <body>
        <nav aria-label="breadcrumb">
          <ol>
            <li><a href="/docs/">Guide</a></li>
            <li><a href="/docs/page1">Page 1</a></li>
          </ol>
        </nav>
        <h1>Page 1</h1>
        <a rel="next" href="/docs/page2">Next</a>
      </body>
      </html>
    `;

    const page2Html = `
      <html>
      <head><title>Page 2</title></head>
      <body>
        <nav aria-label="breadcrumb">
          <ol>
            <li><a href="/docs/">Guide</a></li>
            <li><a href="/docs/page2">Page 2</a></li>
          </ol>
        </nav>
        <h1>Page 2</h1>
        <!-- No next link -->
      </body>
      </html>
    `;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('page1')) {
        return { ok: true, text: async () => page1Html } as any;
      }
      return { ok: true, text: async () => page2Html } as any;
    });

    const config = parseSiteConfig({
      id: 'test-site',
      name: 'Test Site',
      entryUrl: 'https://docs.local/docs/page1',
      discover: {
        strategy: 'next-chain',
        nextSelector: 'a[rel="next"]',
      },
      scope: {
        allowPrefixes: ['https://docs.local/docs/'],
      },
    });

    const discover = new DiscoverPipeline(config, fsInstance);
    const manifest = await discover.run();

    expect(manifest).toHaveLength(2);
    expect(manifest[0].url).toBe('https://docs.local/docs/page1');
    expect(manifest[1].url).toBe('https://docs.local/docs/page2');
    expect(manifest[0].breadcrumb).toEqual(['Guide', 'Page 1']);
  });

  it('discovers pages via sitemap strategy', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://docs.local/docs/getting-started</loc></url>
        <url><loc>https://docs.local/docs/configuration</loc></url>
        <url><loc>https://docs.local/docs/api/internal</loc></url>
        <url><loc>https://docs.local/blog/post1</loc></url>
      </urlset>
    `;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => sitemapXml,
    } as any);

    const config = parseSiteConfig({
      id: 'test-site',
      name: 'Test Site',
      entryUrl: 'https://docs.local/docs/getting-started',
      discover: {
        strategy: 'sitemap',
        sitemapUrl: 'https://docs.local/sitemap.xml',
      },
      scope: {
        allowPrefixes: ['https://docs.local/docs/'],
        excludePatterns: ['/api/'],
      },
    });

    const discover = new DiscoverPipeline(config, fsInstance);
    const manifest = await discover.run();

    // Blog is outside allowPrefixes, /api/ is in excludePatterns
    expect(manifest).toHaveLength(2);
    expect(manifest[0].url).toBe('https://docs.local/docs/configuration');
    expect(manifest[1].url).toBe('https://docs.local/docs/getting-started');
  });
});
