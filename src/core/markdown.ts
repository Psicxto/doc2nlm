/**
 * Markdown utilities:
 * 1. Safe Heading Demotion: Shift headers down by 1 level while strictly preserving fenced code blocks.
 * 2. H2/H3 Heading Extraction: Extract H2/H3 outline outside code blocks.
 * 3. Mixed CJK & English Word Count Estimation.
 */

/**
 * Safely demote markdown headings by 1 level:
 * # -> ##
 * ## -> ###
 * ...
 * ###### -> ###### (max depth)
 * Fenced code blocks (``` or ~~~) are strictly preserved without modifying inner comments/code.
 */
export function demoteHeadings(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;
  let codeFenceChar = '';
  let codeFenceLength = 0;

  const resultLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Check code fence
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const char = fence[0];
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFenceChar = char;
        codeFenceLength = fence.length;
      } else if (char === codeFenceChar && fence.length >= codeFenceLength) {
        inCodeBlock = false;
        codeFenceChar = '';
        codeFenceLength = 0;
      }
      resultLines.push(line);
      continue;
    }

    if (inCodeBlock) {
      resultLines.push(line);
      continue;
    }

    // Demote ATX headings: # -> ##, ## -> ###, etc.
    const headingMatch = line.match(/^(\s*)(#{1,6})(\s+.*)$/);
    if (headingMatch) {
      const leadingSpaces = headingMatch[1];
      const hashes = headingMatch[2];
      const rest = headingMatch[3];

      const newHashes = hashes.length < 6 ? '#' + hashes : hashes;
      resultLines.push(`${leadingSpaces}${newHashes}${rest}`);
      continue;
    }

    resultLines.push(line);
  }

  return resultLines.join('\n');
}

/**
 * Extracts H2 and H3 headings from markdown (skipping fenced code blocks).
 */
export function extractHeadings(markdown: string): Array<{ level: number; text: string }> {
  const lines = markdown.split(/\r?\n/);
  let inCodeBlock = false;
  let codeFenceChar = '';
  let codeFenceLength = 0;

  const headings: Array<{ level: number; text: string }> = [];

  for (const line of lines) {
    const trimmed = line.trimStart();

    // Check code fence
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const char = fence[0];
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFenceChar = char;
        codeFenceLength = fence.length;
      } else if (char === codeFenceChar && fence.length >= codeFenceLength) {
        inCodeBlock = false;
        codeFenceChar = '';
        codeFenceLength = 0;
      }
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    const headingMatch = line.match(/^(\s*)(#{2,3})\s+(.+?)(?:\s+#+)?$/);
    if (headingMatch) {
      const level = headingMatch[2].length; // 2 for H2, 3 for H3
      let text = headingMatch[3].trim();

      // Clean markdown link formatting [text](url) -> text
      text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      // Clean inline code `code` -> code
      text = text.replace(/`([^`]+)`/g, '$1');

      if (text) {
        headings.push({ level, text });
      }
    }
  }

  return headings;
}

/**
 * Estimates word / character count for mixed Chinese and English text.
 * Each CJK character counts as 1 word unit;
 * English / non-CJK words are counted by whitespace-separated tokens.
 */
export function estimateWordCount(text: string): number {
  if (!text || text.trim().length === 0) {
    return 0;
  }

  // Count CJK characters (Chinese, Japanese Kana/Kanji, Korean Hangul)
  const cjkMatches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK characters to count remaining non-CJK words
  const nonCjkText = text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const nonCjkWords = nonCjkText
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && /\w/.test(w));

  return cjkCount + nonCjkWords.length;
}
