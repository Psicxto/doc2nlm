import path from 'node:path';
import type { SiteConfig, ExtractedPage, QualityReport } from '../config.js';
import { demoteHeadings } from '../core/markdown.js';
import { WorkspaceFS } from '../core/fs.js';

interface ModuleGroup {
  key: string;
  title: string;
  pages: ExtractedPage[];
  totalWords: number;
}

export class PackagePipeline {
  constructor(
    private config: SiteConfig,
    private fs: WorkspaceFS = new WorkspaceFS()
  ) {}

  async run(): Promise<QualityReport> {
    const pages = await this.fs.loadExtracted(this.config.id);
    console.log(`[Package] Packaging ${pages.length} pages for NotebookLM...`);

    // Clean previous output
    await this.fs.cleanOutputDir(this.config.id);

    // 1. Group pages by moduleKey
    let groups = this.groupPagesByModule(pages);

    // 2. Apply Guardrail A: Large module auto-split
    groups = this.applyLargeModuleSplit(groups);

    // 3. Apply Guardrail B: Small module merge
    groups = this.applySmallModuleMerge(groups);

    // 4. Generate encapsulated module files
    const bundleFilesSummary: Array<{
      filename: string;
      title: string;
      pageCount: number;
      wordCount: number;
      chapters: string[];
    }> = [];

    let totalWordsAll = 0;
    let maxWordsInSingleFile = 0;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const seq = String(i + 1).padStart(2, '0');
      // Sanitize filename
      const safeTitle = group.title.replace(/[\\/:*?"<>|]/g, '-').trim();
      const filename = `${seq}-${safeTitle}.md`;

      const { fileContent, chapters, fileWords } = await this.generateModuleFileContent(
        group.title,
        group.pages
      );

      await this.fs.saveOutputFile(this.config.id, filename, fileContent);

      totalWordsAll += fileWords;
      if (fileWords > maxWordsInSingleFile) {
        maxWordsInSingleFile = fileWords;
      }

      bundleFilesSummary.push({
        filename,
        title: group.title,
        pageCount: group.pages.length,
        wordCount: fileWords,
        chapters,
      });
    }

    // 5. Generate Global Cognitive Map: 00-文档总览与目录地图.md
    const mapContent = this.generateCatalogMap(pages, bundleFilesSummary);
    await this.fs.saveOutputFile(this.config.id, '00-文档总览与目录地图.md', mapContent);

    // 6. Build Quality Report
    const report: QualityReport = {
      siteId: this.config.id,
      siteName: this.config.name,
      generatedAt: new Date().toISOString(),
      emptyOrTinyPages: pages
        .filter((p) => p.status !== 'error' && p.wordCount < 50)
        .map((p) => ({ url: p.url, title: p.finalTitle, wordCount: p.wordCount })),
      oversizedPages: pages
        .filter((p) => p.wordCount > 25000)
        .map((p) => ({ url: p.url, title: p.finalTitle, wordCount: p.wordCount })),
      failedPages: pages
        .filter((p) => p.status === 'error')
        .map((p) => ({ url: p.url, error: p.errorMessage })),
      bundleSummary: {
        totalFiles: bundleFilesSummary.length,
        totalWords: totalWordsAll,
        maxWordsInSingleFile,
        files: bundleFilesSummary,
      },
    };

    await this.fs.saveReport(this.config.id, report);
    this.printSummary(report);

    return report;
  }

  /**
   * Group pages in strict manifest order by moduleKey
   */
  private groupPagesByModule(pages: ExtractedPage[]): ModuleGroup[] {
    const groupMap = new Map<string, ModuleGroup>();
    const order: string[] = [];

    for (const page of pages) {
      const key = page.moduleKey || (page.breadcrumb[0] ?? '默认模块');
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          title: key,
          pages: [],
          totalWords: 0,
        });
        order.push(key);
      }
      const group = groupMap.get(key)!;
      group.pages.push(page);
      group.totalWords += page.wordCount;
    }

    return order.map((key) => groupMap.get(key)!);
  }

  /**
   * Guardrail A: Large module auto-split if cumulative words exceed maxWordsPerFile
   */
  private applyLargeModuleSplit(groups: ModuleGroup[]): ModuleGroup[] {
    const maxWords = this.config.notebooklm.maxWordsPerFile ?? 120000;
    const result: ModuleGroup[] = [];

    for (const group of groups) {
      if (group.totalWords <= maxWords || group.pages.length <= 1) {
        result.push(group);
        continue;
      }

      // Try splitting by secondary category (breadcrumb[1])
      const subGroupsMap = new Map<string, ExtractedPage[]>();
      const subOrder: string[] = [];

      for (const page of group.pages) {
        const subKey = page.breadcrumb[1] || '其他';
        if (!subGroupsMap.has(subKey)) {
          subGroupsMap.set(subKey, []);
          subOrder.push(subKey);
        }
        subGroupsMap.get(subKey)!.push(page);
      }

      if (subOrder.length > 1) {
        // Split succeeded by subKey
        for (let idx = 0; idx < subOrder.length; idx++) {
          const subKey = subOrder[idx];
          const subPages = subGroupsMap.get(subKey)!;
          const subWords = subPages.reduce((acc, p) => acc + p.wordCount, 0);
          const suffixLetter = String.fromCharCode(97 + (idx % 26)); // a, b, c...
          result.push({
            key: `${group.key}-${subKey}`,
            title: `${group.title}-${subKey}`,
            pages: subPages,
            totalWords: subWords,
          });
        }
      } else {
        // If secondary category not available, split by chunking pages
        let currentChunkPages: ExtractedPage[] = [];
        let currentChunkWords = 0;
        let chunkIndex = 1;

        for (const page of group.pages) {
          if (currentChunkWords + page.wordCount > maxWords && currentChunkPages.length > 0) {
            result.push({
              key: `${group.key}-part${chunkIndex}`,
              title: `${group.title}-第${chunkIndex}部分`,
              pages: currentChunkPages,
              totalWords: currentChunkWords,
            });
            chunkIndex++;
            currentChunkPages = [];
            currentChunkWords = 0;
          }
          currentChunkPages.push(page);
          currentChunkWords += page.wordCount;
        }

        if (currentChunkPages.length > 0) {
          result.push({
            key: `${group.key}-part${chunkIndex}`,
            title: chunkIndex > 1 ? `${group.title}-第${chunkIndex}部分` : group.title,
            pages: currentChunkPages,
            totalWords: currentChunkWords,
          });
        }
      }
    }

    return result;
  }

  /**
   * Guardrail B: Small module merge if total groups exceed targetMaxFiles
   */
  private applySmallModuleMerge(groups: ModuleGroup[]): ModuleGroup[] {
    const targetMax = this.config.notebooklm.targetMaxFiles ?? 25;
    const minWordsToMerge = this.config.notebooklm.minWordsToMerge ?? 3000;

    if (groups.length <= targetMax) {
      return groups;
    }

    const result: ModuleGroup[] = [];
    let pendingSmallGroup: ModuleGroup | null = null;

    for (const group of groups) {
      if (group.totalWords < minWordsToMerge) {
        if (!pendingSmallGroup) {
          pendingSmallGroup = {
            key: group.key,
            title: group.title,
            pages: [...group.pages],
            totalWords: group.totalWords,
          };
        } else {
          // Merge with pending small group
          pendingSmallGroup.key += `_${group.key}`;
          pendingSmallGroup.title = `${pendingSmallGroup.title}与${group.title}`;
          pendingSmallGroup.pages.push(...group.pages);
          pendingSmallGroup.totalWords += group.totalWords;

          if (pendingSmallGroup.totalWords >= minWordsToMerge) {
            result.push(pendingSmallGroup);
            pendingSmallGroup = null;
          }
        }
      } else {
        if (pendingSmallGroup) {
          result.push(pendingSmallGroup);
          pendingSmallGroup = null;
        }
        result.push(group);
      }
    }

    if (pendingSmallGroup) {
      if (result.length > 0) {
        // Merge remaining into last group
        const last = result[result.length - 1];
        last.title = `${last.title}与${pendingSmallGroup.title}`;
        last.pages.push(...pendingSmallGroup.pages);
        last.totalWords += pendingSmallGroup.totalWords;
      } else {
        result.push(pendingSmallGroup);
      }
    }

    return result;
  }

  /**
   * Generates single module file content:
   * # Module Title
   * Followed by each page's demoted content with context header
   */
  private async generateModuleFileContent(
    moduleTitle: string,
    pages: ExtractedPage[]
  ): Promise<{ fileContent: string; chapters: string[]; fileWords: number }> {
    const chapters: string[] = [];
    let fileWords = 0;
    const sections: string[] = [`# ${moduleTitle}\n`];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      chapters.push(page.finalTitle);
      fileWords += page.wordCount;

      let rawMd = '';
      if (page.hash) {
        try {
          rawMd = await this.fs.loadPageMd(this.config.id, page.hash);
        } catch {
          rawMd = `*(页面内容提取失败)*`;
        }
      }

      // Demote headings by 1 level
      const demotedBody = demoteHeadings(rawMd);

      const pathStr = page.breadcrumb.length > 0 ? page.breadcrumb.join(' > ') : page.finalTitle;
      const prevStr = page.prevTitle ? `上一页「${page.prevTitle}」` : '第一页';
      const nextStr = page.nextTitle ? `下一页「${page.nextTitle}」` : '最后一页';

      const pageSection = [
        `## ${page.finalTitle}`,
        `> **所属路径**：${pathStr}`,
        `> **原始文档**：${page.url}`,
        `> **阅读顺序**：${prevStr} / ${nextStr}`,
        '',
        demotedBody,
      ].join('\n');

      sections.push(pageSection);
    }

    return {
      fileContent: sections.join('\n\n---\n\n'),
      chapters,
      fileWords,
    };
  }

  /**
   * Generates 00-文档总览与目录地图.md
   */
  private generateCatalogMap(
    pages: ExtractedPage[],
    bundleFiles: Array<{ filename: string; title: string; pageCount: number; wordCount: number; chapters: string[] }>
  ): string {
    const today = new Date().toISOString().split('T')[0];
    const totalPages = pages.length;
    const totalModuleFiles = bundleFiles.length;

    const lines: string[] = [
      `# ${this.config.name} 官方使用文档 — 全局目录地图`,
      '',
      `- **文档入口**：${this.config.entryUrl}`,
      `- **收录范围**：仅包含使用文档，共 ${totalPages} 页，整理为 ${totalModuleFiles} 个模块文件`,
      `- **抓取日期**：${today}`,
      '',
      `## 一、模块文件索引（按需在左侧勾选）`,
      '',
      `| 模块文件 | 覆盖章节 | 页数 | 约计词数 |`,
      `| :--- | :--- | :--- | :--- |`,
    ];

    for (const file of bundleFiles) {
      const chaptersPreview =
        file.chapters.slice(0, 3).join(' / ') + (file.chapters.length > 3 ? ` 等共 ${file.chapters.length} 篇` : '');
      lines.push(`| \`${file.filename}\` | ${chaptersPreview} | ${file.pageCount} | ${file.wordCount.toLocaleString()} |`);
    }

    lines.push('', `## 二、全站树状目录与小节提纲`);

    // Group outline by bundle file
    for (const file of bundleFiles) {
      lines.push('', `### ${file.title} (\`${file.filename}\`)`);
      for (const chapterTitle of file.chapters) {
        const page = pages.find((p) => p.finalTitle === chapterTitle);
        if (page) {
          lines.push(`- **${page.finalTitle}** (\`${page.url}\`)`);
          if (page.headings && page.headings.length > 0) {
            const headingOutline = page.headings
              .slice(0, 8)
              .map((h) => h.text)
              .join(' / ');
            lines.push(`  - ${headingOutline}`);
          }
        } else {
          lines.push(`- **${chapterTitle}**`);
        }
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  private printSummary(report: QualityReport): void {
    console.log('\n========================================');
    console.log(`  doc2nlm 质检与打包摘要: ${report.siteName}`);
    console.log('========================================');
    console.log(`生成时间: ${report.generatedAt}`);
    console.log(`输出文件数: ${report.bundleSummary.totalFiles}`);
    console.log(`总收录词数: ${report.bundleSummary.totalWords.toLocaleString()}`);
    console.log(`单文件最大词数: ${report.bundleSummary.maxWordsInSingleFile.toLocaleString()}`);

    if (report.emptyOrTinyPages.length > 0) {
      console.log(`\n[警告] 疑似空白/极小页面 (<50词) (${report.emptyOrTinyPages.length}页):`);
      for (const p of report.emptyOrTinyPages.slice(0, 5)) {
        console.log(`  - ${p.title} (${p.wordCount}词): ${p.url}`);
      }
      if (report.emptyOrTinyPages.length > 5) {
        console.log(`  ... 更多见 report.json`);
      }
    }

    if (report.oversizedPages.length > 0) {
      console.log(`\n[警告] 超大页面 (>25,000词) (${report.oversizedPages.length}页):`);
      for (const p of report.oversizedPages.slice(0, 5)) {
        console.log(`  - ${p.title} (${p.wordCount}词): ${p.url}`);
      }
    }

    if (report.failedPages.length > 0) {
      console.log(`\n[错误] 失败页面 (${report.failedPages.length}页):`);
      for (const p of report.failedPages.slice(0, 5)) {
        console.log(`  - ${p.url}: ${p.error}`);
      }
    }

    console.log('\n输出文件清单 (workspace/' + report.siteId + '/output/):');
    for (const f of report.bundleSummary.files) {
      console.log(`  * ${f.filename.padEnd(30)} [${f.pageCount}页, ${f.wordCount.toLocaleString()}词]`);
    }
    console.log('  * 00-文档总览与目录地图.md');
    console.log('========================================\n');
  }
}
