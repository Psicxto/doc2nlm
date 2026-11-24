import { describe, it, expect } from 'vitest';
import { parseSiteConfig } from '../src/config.js';

describe('config', () => {
  it('parses valid config with defaults filled', () => {
    const raw = {
      id: 'test-site',
      name: 'Test Site',
      entryUrl: 'https://example.com/docs/',
      discover: {
        strategy: 'sidebar',
        sidebarSelector: 'nav.sidebar',
      },
      scope: {
        allowPrefixes: ['https://example.com/docs/'],
      },
    };

    const config = parseSiteConfig(raw);
    expect(config.id).toBe('test-site');
    expect(config.fetch.mode).toBe('http');
    expect(config.fetch.concurrency).toBe(5);
    expect(config.fetch.delayMs).toBe(200);
    expect(config.notebooklm.groupByDepth).toBe(1);
    expect(config.notebooklm.targetMaxFiles).toBe(25);
    expect(config.notebooklm.maxWordsPerFile).toBe(120000);
    expect(config.notebooklm.minWordsToMerge).toBe(3000);
    expect(config.notebooklm.keepExternalImages).toBe(true);
  });

  it('validates sidebar strategy requires sidebarSelector', () => {
    const raw = {
      id: 'test-site',
      name: 'Test Site',
      entryUrl: 'https://example.com/docs/',
      discover: {
        strategy: 'sidebar',
      },
      scope: {
        allowPrefixes: ['https://example.com/docs/'],
      },
    };

    expect(() => parseSiteConfig(raw)).toThrow();
  });
});
