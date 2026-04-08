import { Settings } from '../types/settings';
import {
  collapseBlankLines,
  collapseInlineSpacing,
  normalizeInvisibleCharacters,
  removeConfiguredPhrases,
  removeTrailingSpaces
} from './rules';

function isProbablyCodeSnippet(input: string): boolean {
  if (!input) return false;
  if (input.includes('\t')) return true;
  if (input.includes('```')) return true;
  if (/^\s{2,}\S/m.test(input)) return true;
  if (/^\s*at\s+\S+/m.test(input) && /\n/.test(input)) return true; // stack traces
  return false;
}

export function sanitizeClipboardText(input: string, settings: Settings): string {
  let result = input;
  result = normalizeInvisibleCharacters(
    result,
    settings.ruleFlags.replaceNonBreakingSpaces,
    settings.ruleFlags.removeZeroWidthSpaces
  );
  result = removeConfiguredPhrases(result, settings.phraseFilters);

  if (isProbablyCodeSnippet(result)) {
    return result;
  }

  if (settings.ruleFlags.collapseInlineSpacing) {
    result = collapseInlineSpacing(result);
  }
  if (settings.ruleFlags.collapseBlankLines) {
    result = collapseBlankLines(result);
  }
  if (settings.ruleFlags.removeTrailingSpaces) {
    result = removeTrailingSpaces(result);
  }
  if (settings.trimWhitespace) {
    result = result.trim();
  }
  return result;
}
