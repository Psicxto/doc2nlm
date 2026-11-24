import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSiteConfig, type SiteConfig } from './config.js';
import { DiscoverPipeline } from './pipeline/01-discover.js';
import { FetchPipeline } from './pipeline/02-fetch.js';
import { ExtractPipeline } from './pipeline/03-extract.js';
import { PackagePipeline } from './pipeline/04-package.js';
import { WorkspaceFS } from './core/fs.js';

async function loadConfig(configPath: string): Promise<SiteConfig> {
  const resolvedPath = path.resolve(process.cwd(), configPath);
  try {
    const raw = await fs.readFile(resolvedPath, 'utf-8');
    const json = JSON.parse(raw);
    return parseSiteConfig(json);
  } catch (err: any) {
    console.error(`[Error] Failed to load config from "${configPath}": ${err.message}`);
    process.exit(1);
  }
}

const program = new Command();

program
  .name('doc2nlm')
  .description('Convert web documentation into RAG-optimized corpus for NotebookLM')
  .version('0.1.0');

// Command: run (Stage 1 -> Stage 2 -> Stage 3 -> Stage 4)
program
  .command('run <configPath>')
  .description('Execute full pipeline: discover -> fetch -> extract -> package')
  .option('-f, --force', 'Force re-fetching even if raw HTML cache exists', false)
  .action(async (configPath: string, options: { force?: boolean }) => {
    const config = await loadConfig(configPath);
    const workspaceFS = new WorkspaceFS();

    console.log(`\n========================================`);
    console.log(`  Starting doc2nlm pipeline for: ${config.name}`);
    console.log(`========================================\n`);

    // Stage 1: Discover
    console.log('>>> Stage 1: Discovering site topology...');
    const discover = new DiscoverPipeline(config, workspaceFS);
    const manifest = await discover.run();
    if (manifest.length === 0) {
      console.error('[Error] No pages discovered. Stopping pipeline.');
      process.exit(1);
    }

    // Stage 2: Fetch
    console.log('\n>>> Stage 2: Fetching HTML snapshots...');
    const fetchPipeline = new FetchPipeline(config, workspaceFS);
    await fetchPipeline.run({ force: options.force });

    // Stage 3: Extract
    console.log('\n>>> Stage 3: Extracting Markdown with Defuddle...');
    const extract = new ExtractPipeline(config, workspaceFS);
    await extract.run();

    // Stage 4: Package
    console.log('\n>>> Stage 4: Packaging and generating quality report...');
    const pkg = new PackagePipeline(config, workspaceFS);
    await pkg.run();

    console.log('Pipeline finished successfully!');
  });

// Command: discover (Stage 1)
program
  .command('discover <configPath>')
  .description('Execute Stage 1: Discover pages and generate manifest.json')
  .action(async (configPath: string) => {
    const config = await loadConfig(configPath);
    const workspaceFS = new WorkspaceFS();
    const discover = new DiscoverPipeline(config, workspaceFS);
    const items = await discover.run();
    console.log(`\n[Done] Discovered ${items.length} pages. Manifest saved to workspace/${config.id}/manifest.json`);
  });

// Command: fetch (Stage 2)
program
  .command('fetch <configPath>')
  .description('Execute Stage 2: Fetch raw HTML for items in manifest.json')
  .option('-f, --force', 'Force re-fetching even if raw HTML cache exists', false)
  .action(async (configPath: string, options: { force?: boolean }) => {
    const config = await loadConfig(configPath);
    const workspaceFS = new WorkspaceFS();
    const fetchPipeline = new FetchPipeline(config, workspaceFS);
    await fetchPipeline.run({ force: options.force });
  });

// Command: extract (Stage 3)
program
  .command('extract <configPath>')
  .description('Execute Stage 3: Offline Defuddle extraction from raw_html to pages_md')
  .action(async (configPath: string) => {
    const config = await loadConfig(configPath);
    const workspaceFS = new WorkspaceFS();
    const extract = new ExtractPipeline(config, workspaceFS);
    await extract.run();
  });

// Command: repack / package (Stage 4)
program
  .command('repack <configPath>')
  .alias('package')
  .description('Execute Stage 4: Repackage Markdown files from cache into output/ without fetching')
  .action(async (configPath: string) => {
    const config = await loadConfig(configPath);
    const workspaceFS = new WorkspaceFS();
    const pkg = new PackagePipeline(config, workspaceFS);
    await pkg.run();
  });

export async function runCli(): Promise<void> {
  await program.parseAsync(process.argv);
}

// Auto-run if executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  runCli();
}
