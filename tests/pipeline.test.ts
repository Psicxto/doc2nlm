import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSiteConfig, type ExtractedPage } from '../src/config.js';
import { WorkspaceFS } from '../src/core/fs.js';
import { PackagePipeline } from '../src/pipeline/04-package.js';
import { ExtractPipeline } from '../src/pipeline/03-extract.js';

const testWorkspaceDir = path.resolve('workspace-test');

describe('pipeline integration test', () => {
  const fsInstance = new WorkspaceFS(testWorkspaceDir);

  const mockConfig = parseSiteConfig({
    id: 'mock-site',
    name: 'Mock Test Site',
    entryUrl: 'https://mock.local/docs/intro',
    discover: {
      strategy: 'sidebar',
      sidebarSelector: 'nav.sidebar',
    },
    scope: {
      allowPrefixes: ['https://mock.local/docs/'],
    },
    notebooklm: {
      groupByDepth: 1,
      targetMaxFiles: 2,
      maxWordsPerFile: 100, // Small limit to test splitting
      minWordsToMerge: 50,  // Small limit to test merging
    },
  });

  beforeEach(async () => {
    await fsInstance.ensureSiteDirs(mockConfig.id);
  });

  afterEach(async () => {
    await fs.rm(testWorkspaceDir, { recursive: true, force: true }).catch(() => {});
  });

  it('extracts pages using Defuddle from raw_html and saves pages_md', async () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Getting Started - Mock Doc</title></head>
      <body>
        <main>
          <h1>Getting Started</h1>
          <p>Welcome to mock documentation. This tool helps you convert docs.</p>
          <h2>Installation</h2>
          <p>Run npm install to install.</p>
        </main>
      </body>
      </html>
    `;

    const hash = 'abc1234567';
    await fsInstance.saveRawHtml(mockConfig.id, hash, rawHtml);

    await fsInstance.saveManifest(mockConfig.id, [
      {
        index: 0,
        url: 'https://mock.local/docs/intro',
        hash,
        title: 'Getting Started',
        breadcrumb: ['Guide', 'Getting Started'],
        moduleKey: 'Guide',
      },
    ]);

    const extract = new ExtractPipeline(mockConfig, fsInstance);
    const pages = await extract.run();

    expect(pages).toHaveLength(1);
    expect(pages[0].finalTitle).toContain('Getting Started');
    expect(pages[0].status).toBe('ok');
    expect(pages[0].headings).toEqual([
      { level: 2, text: 'Getting Started' },
      { level: 2, text: 'Installation' },
    ]);

    const savedMd = await fsInstance.loadPageMd(mockConfig.id, hash);
    expect(savedMd).toContain('Installation');
  });

  it('packages extracted pages into module files, generates catalog map and report', async () => {
    const extractedPages: ExtractedPage[] = [
      {
        index: 0,
        url: 'https://mock.local/docs/quickstart',
        hash: 'hash1',
        title: 'Quickstart',
        finalTitle: '快速开始指南',
        breadcrumb: ['快速上手', '安装部署'],
        moduleKey: '快速上手',
        headings: [{ level: 2, text: '系统要求' }, { level: 3, text: '单机部署' }],
        wordCount: 80,
        mdFilePath: 'pages_md/hash1.md',
        status: 'ok',
        prevTitle: undefined,
        nextTitle: '进阶用法',
      },
      {
        index: 1,
        url: 'https://mock.local/docs/advanced',
        hash: 'hash2',
        title: 'Advanced',
        finalTitle: '进阶用法',
        breadcrumb: ['快速上手', '进阶配置'],
        moduleKey: '快速上手',
        headings: [{ level: 2, text: '性能调优' }],
        wordCount: 80, // Total in '快速上手' will be 160 > maxWordsPerFile(100), triggering auto-split!
        mdFilePath: 'pages_md/hash2.md',
        status: 'ok',
        prevTitle: '快速开始指南',
        nextTitle: undefined,
      },
    ];

    await fsInstance.savePageMd(mockConfig.id, 'hash1', '# 快速开始指南\n\n正文描述。\n\n## 系统要求\n\nLinux/macOS');
    await fsInstance.savePageMd(mockConfig.id, 'hash2', '# 进阶用法\n\n正文描述。\n\n## 性能调优\n\n参数详情');
    await fsInstance.saveExtracted(mockConfig.id, extractedPages);

    const pkg = new PackagePipeline(mockConfig, fsInstance);
    const report = await pkg.run();

    expect(report.siteId).toBe(mockConfig.id);
    expect(report.bundleSummary.totalFiles).toBeGreaterThan(0);

    // Verify 00-文档总览与目录地图.md exists
    const mapContent = await fs.readFile(
      path.join(fsInstance.getOutputDir(mockConfig.id), '00-文档总览与目录地图.md'),
      'utf-8'
    );
    expect(mapContent).toContain('全局目录地图');
    expect(mapContent).toContain('快速开始指南');
    expect(mapContent).toContain('系统要求');

    // Verify generated module files
    const outputFiles = await fs.readdir(fsInstance.getOutputDir(mockConfig.id));
    expect(outputFiles).toContain('00-文档总览与目录地图.md');

    // Check demotion and context headers in module file
    const moduleFile = outputFiles.find((f) => f.startsWith('01-'));
    expect(moduleFile).toBeDefined();

    const moduleContent = await fs.readFile(
      path.join(fsInstance.getOutputDir(mockConfig.id), moduleFile!),
      'utf-8'
    );

    // H1 for module title
    expect(moduleContent).toMatch(/^# /m);
    // H2 for page title
    expect(moduleContent).toContain('## 快速开始指南');
    // Context header injection
    expect(moduleContent).toContain('> **所属路径**：');
    expect(moduleContent).toContain('> **原始文档**：https://mock.local/docs/quickstart');
    expect(moduleContent).toContain('> **阅读顺序**：');
  });
});
