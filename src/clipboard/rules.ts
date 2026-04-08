const ZERO_WIDTH_REGEX = /[\u200B\u200C\u200D\uFEFF]/g;
const MULTI_SPACE_REGEX = /[ \t]{2,}/g;
const TRIM_TRAILING_SPACES_REGEX = /[ \t]+(?=\r?\n)/g;
const BLANK_LINE_REGEX = /(\r?\n){3,}/g;

export function normalizeInvisibleCharacters(input: string, replaceNbsp: boolean, removeZeroWidth: boolean): string {
  let value = input;
  if (replaceNbsp) {
    value = value.replace(/\u00A0/g, ' ');
  }
  if (removeZeroWidth) {
    value = value.replace(ZERO_WIDTH_REGEX, '');
  }
  return value;
}

function escapeRegExpChar(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFlexiblePhraseRegex(phrase: string): RegExp | null {
  const trimmed = phrase.trim();
  if (!trimmed) return null;

  const zeroWidthOptional = '[\\u200B\\u200C\\u200D\\uFEFF]*';
  let pattern = '';

  for (const ch of Array.from(trimmed)) {
    if (ch === ' ' || ch === '\t' || ch === '\u00A0') {
      pattern += '[ \\t\\u00A0]+';
      continue;
    }
    pattern += escapeRegExpChar(ch) + zeroWidthOptional;
  }

  return new RegExp(pattern, 'gi');
}

export function removeConfiguredPhrases(input: string, phrases: string[]): string {
  if (!phrases.length) {
    return input;
  }

  const regexes = phrases
    .map((phrase) => (typeof phrase === 'string' ? buildFlexiblePhraseRegex(phrase) : null))
    .filter((regex): regex is RegExp => Boolean(regex));

  if (!regexes.length) {
    return input;
  }

  // For multi-line clipboard content (console errors, stack traces, logs), removing the whole line
  // is typically more useful than deleting the matching substring.
  if (input.includes('\n')) {
    const newline = input.includes('\r\n') ? '\r\n' : '\n';
    const lines = input.split(/\r?\n/);
    const kept = lines.filter(
      (line) =>
        !regexes.some((regex) => {
          // Our regexes are global (`g`) for replacement. `RegExp#test` mutates `lastIndex` when
          // `g` is set, which can cause inconsistent matches across lines unless we reset it.
          regex.lastIndex = 0;
          return regex.test(line);
        })
    );
    return kept.join(newline);
  }

  // Single-line content: remove just the matched substring(s).
  return regexes.reduce((acc, regex) => acc.replace(regex, ''), input);
}

export function collapseInlineSpacing(input: string): string {
  return input.replace(MULTI_SPACE_REGEX, ' ');
}

export function collapseBlankLines(input: string): string {
  return input.replace(BLANK_LINE_REGEX, '\n\n');
}

export function removeTrailingSpaces(input: string): string {
  return input.replace(TRIM_TRAILING_SPACES_REGEX, '');
}
