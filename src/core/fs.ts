import fs from 'node:fs/promises';
import path from 'node:path';
import type { ManifestItem, ExtractedPage, QualityReport } from '../config.js';

export class WorkspaceFS {
  private baseDir: string;

  constructor(workspaceRoot = 'workspace') {
    this.baseDir = path.resolve(workspaceRoot);
  }

  getSiteDir(siteId: string): string {
    return path.join(this.baseDir, siteId);
  }

  getRawHtmlDir(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'raw_html');
  }

  getPagesMdDir(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'pages_md');
  }

  getOutputDir(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'output');
  }

  getManifestPath(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'manifest.json');
  }

  getExtractedPath(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'extracted.json');
  }

  getReportPath(siteId: string): string {
    return path.join(this.getSiteDir(siteId), 'report.json');
  }

  async ensureSiteDirs(siteId: string): Promise<void> {
    await fs.mkdir(this.getSiteDir(siteId), { recursive: true });
    await fs.mkdir(this.getRawHtmlDir(siteId), { recursive: true });
    await fs.mkdir(this.getPagesMdDir(siteId), { recursive: true });
    await fs.mkdir(this.getOutputDir(siteId), { recursive: true });
  }

  async saveManifest(siteId: string, items: ManifestItem[]): Promise<void> {
    await this.ensureSiteDirs(siteId);
    await fs.writeFile(
      this.getManifestPath(siteId),
      JSON.stringify(items, null, 2),
      'utf-8'
    );
  }

  async loadManifest(siteId: string): Promise<ManifestItem[]> {
    const raw = await fs.readFile(this.getManifestPath(siteId), 'utf-8');
    return JSON.parse(raw);
  }

  async hasManifest(siteId: string): Promise<boolean> {
    try {
      await fs.access(this.getManifestPath(siteId));
      return true;
    } catch {
      return false;
    }
  }

  getRawHtmlPath(siteId: string, hash: string): string {
    return path.join(this.getRawHtmlDir(siteId), `${hash}.html`);
  }

  async hasRawHtml(siteId: string, hash: string): Promise<boolean> {
    try {
      await fs.access(this.getRawHtmlPath(siteId, hash));
      return true;
    } catch {
      return false;
    }
  }

  async saveRawHtml(siteId: string, hash: string, html: string): Promise<void> {
    await this.ensureSiteDirs(siteId);
    await fs.writeFile(this.getRawHtmlPath(siteId, hash), html, 'utf-8');
  }

  async loadRawHtml(siteId: string, hash: string): Promise<string> {
    return fs.readFile(this.getRawHtmlPath(siteId, hash), 'utf-8');
  }

  getPageMdPath(siteId: string, hash: string): string {
    return path.join(this.getPagesMdDir(siteId), `${hash}.md`);
  }

  async savePageMd(siteId: string, hash: string, md: string): Promise<string> {
    await this.ensureSiteDirs(siteId);
    const filePath = this.getPageMdPath(siteId, hash);
    await fs.writeFile(filePath, md, 'utf-8');
    return filePath;
  }

  async loadPageMd(siteId: string, hash: string): Promise<string> {
    return fs.readFile(this.getPageMdPath(siteId, hash), 'utf-8');
  }

  async saveExtracted(siteId: string, pages: ExtractedPage[]): Promise<void> {
    await this.ensureSiteDirs(siteId);
    await fs.writeFile(
      this.getExtractedPath(siteId),
      JSON.stringify(pages, null, 2),
      'utf-8'
    );
  }

  async loadExtracted(siteId: string): Promise<ExtractedPage[]> {
    const raw = await fs.readFile(this.getExtractedPath(siteId), 'utf-8');
    return JSON.parse(raw);
  }

  async hasExtracted(siteId: string): Promise<boolean> {
    try {
      await fs.access(this.getExtractedPath(siteId));
      return true;
    } catch {
      return false;
    }
  }

  async saveReport(siteId: string, report: QualityReport): Promise<void> {
    await this.ensureSiteDirs(siteId);
    await fs.writeFile(
      this.getReportPath(siteId),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
  }

  async loadReport(siteId: string): Promise<QualityReport> {
    const raw = await fs.readFile(this.getReportPath(siteId), 'utf-8');
    return JSON.parse(raw);
  }

  async saveOutputFile(siteId: string, filename: string, content: string): Promise<string> {
    await this.ensureSiteDirs(siteId);
    const filePath = path.join(this.getOutputDir(siteId), filename);
    await fs.writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  async cleanOutputDir(siteId: string): Promise<void> {
    const outputDir = this.getOutputDir(siteId);
    try {
      const files = await fs.readdir(outputDir);
      for (const file of files) {
        await fs.unlink(path.join(outputDir, file));
      }
    } catch {
      // directory might not exist yet
    }
  }
}
