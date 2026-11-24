#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, '..', 'dist', 'cli.js');
const srcCli = path.join(__dirname, '..', 'src', 'cli.ts');

if (fs.existsSync(distCli)) {
  const child = spawn(process.execPath, [distCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', srcCli, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
    }
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}
