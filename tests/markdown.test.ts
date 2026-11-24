import { describe, it, expect } from 'vitest';
import { demoteHeadings, extractHeadings, estimateWordCount } from '../src/core/markdown.js';

describe('core/markdown', () => {
  it('demotes headings by 1 level and preserves fenced code blocks', () => {
    const input = [
      '# Document Title',
      '',
      'Some intro text.',
      '',
      '## Section 1',
      '',
      '```python',
      '# This is a python comment, not a markdown heading',
      '## Another comment',
      'def foo():',
      '    pass',
      '```',
      '',
      '### Subsection A',
      '',
      '~~~~',
      '# Tilde code fence comment',
      '~~~~',
      '',
      '###### Deep heading',
    ].join('\n');

    const expected = [
      '## Document Title',
      '',
      'Some intro text.',
      '',
      '### Section 1',
      '',
      '```python',
      '# This is a python comment, not a markdown heading',
      '## Another comment',
      'def foo():',
      '    pass',
      '```',
      '',
      '#### Subsection A',
      '',
      '~~~~',
      '# Tilde code fence comment',
      '~~~~',
      '',
      '###### Deep heading',
    ].join('\n');

    const output = demoteHeadings(input);
    expect(output).toBe(expected);
  });

  it('extracts H2 and H3 headings outside code blocks', () => {
    const input = [
      '# Title (Ignored)',
      '## [First Section](https://example.com)',
      'Text',
      '### `Code` In Heading',
      '```',
      '## Heading inside code block should be ignored',
      '```',
      '#### H4 is ignored',
      '## Second Section',
    ].join('\n');

    const headings = extractHeadings(input);
    expect(headings).toEqual([
      { level: 2, text: 'First Section' },
      { level: 3, text: 'Code In Heading' },
      { level: 2, text: 'Second Section' },
    ]);
  });

  it('estimates word count correctly for mixed CJK and English', () => {
    expect(estimateWordCount('')).toBe(0);

    // Pure English
    const enText = 'Hello world this is a test.';
    expect(estimateWordCount(enText)).toBe(6);

    // Pure Chinese (11 characters)
    const zhText = '这是一段纯中文测试文本。';
    expect(estimateWordCount(zhText)).toBe(11);

    // Mixed text
    const mixed = 'Caddy 是一个强大的 Web 服务器。';
    // 'Caddy' (1) + 'Web' (1) = 2 English words
    // '是一个强大的' (6) + '服务器' (3) = 9 CJK chars
    // Total = 11
    expect(estimateWordCount(mixed)).toBe(11);
  });
});
