import { Settings } from '../types/settings';
import {
  collapseBlankLines,
  collapseInlineSpacing,
  normalizeInvisibleCharacters,
  removeConfiguredPhrases,
  removeTrailingSpaces
} from './rules';

const NO_PASTABLE_TEXT = '[no pastable text]';

function isProbablyCodeSnippet(input: string): boolean {
  if (!input) return false;
  if (input.includes('\t')) return true;
  if (input.includes('```')) return true;
  if (/^\s{2,}\S/m.test(input)) return true;
  if (/^\s*at\s+\S+/m.test(input) && /\n/.test(input)) return true; // stack traces
  return false;
}

function isEffectivelyEmpty(value: string): boolean {
  // Treat pure whitespace and quote/backtick scaffolding as "nothing pastable".
  // This catches cases where filters removed all meaningful text but left blank lines/quotes.
  return value.replace(/[\s"'`]+/g, '').length === 0;
}

function normalizeCodeFrameLine(line: string): string {
  // Normalize Vite/TS/Node style code frames so they paste cleanly:
  //   "  690 |               const x" -> "690 | const x"
  //   "> 692 |     foo" -> "> 692 | foo"
  const match = line.match(/^\s*(>\s*)?(\d+)\s*\|\s+(.*)$/);
  if (!match) return line;
  const pointer = match[1] ?? '';
  const lineNo = match[2];
  const content = match[3].trimStart();
  return `${pointer}${lineNo} | ${content}`;
}

function shouldCollapseDiagnosticLine(line: string): boolean {
  const trimmedStart = line.trimStart();
  if (!trimmedStart) return false;
  if (trimmedStart.startsWith('```')) return false;
  if (/^at\s+\S+/.test(trimmedStart)) return false;
  if (/^(?:>\s*)?\d+\s*\|/.test(trimmedStart)) return false;
  return true;
}

export function sanitizeClipboardText(input: string, settings: Settings): string {
  let result = input;
  result = normalizeInvisibleCharacters(
    result,
    settings.ruleFlags.replaceNonBreakingSpaces,
    settings.ruleFlags.removeZeroWidthSpaces
  );

  const looksLikeCode = isProbablyCodeSnippet(result);
  const isMultiline = result.includes('\n');

  // Apply code-frame + log-line whitespace normalization before phrase filtering so that
  // phrase filters can match what you actually paste.
  if (looksLikeCode && isMultiline) {
    const newline = result.includes('\r\n') ? '\r\n' : '\n';
    const lines = result.split(/\r?\n/);
    result = lines
      .map((line) => {
        const normalizedFrame = normalizeCodeFrameLine(line);
        if (normalizedFrame !== line) return normalizedFrame;
        if (settings.ruleFlags.collapseInlineSpacing && shouldCollapseDiagnosticLine(line)) {
          return collapseInlineSpacing(line);
        }
        return line;
      })
      .join(newline);
  }

  result = removeConfiguredPhrases(result, settings.phraseFilters);

  if (isEffectivelyEmpty(result)) {
    return NO_PASTABLE_TEXT;
  }

  const isCodeSnippet = looksLikeCode;

  if (settings.ruleFlags.collapseInlineSpacing) {
    if (!isCodeSnippet) {
      result = collapseInlineSpacing(result);
    }
  }
  if (settings.ruleFlags.collapseBlankLines) {
    // Safe for code snippets (it doesn't touch indentation), and helps avoid pasting giant gaps.
    result = collapseBlankLines(result);
  }
  if (settings.ruleFlags.removeTrailingSpaces) {
    // Trailing whitespace is almost never meaningful for pasting logs/stack traces.
    result = removeTrailingSpaces(result);
  }
  if (settings.trimWhitespace && !isCodeSnippet) {
    result = result.trim();
  }

  if (isEffectivelyEmpty(result)) {
    return NO_PASTABLE_TEXT;
  }

  return result;
}
