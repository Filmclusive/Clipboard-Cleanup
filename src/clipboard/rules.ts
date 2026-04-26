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
  const wildcardAnyLength = '[^\\r\\n]*?';
  let pattern = '';
  let escaping = false;
  let hasLiteralToken = false;

  const chars = Array.from(trimmed);
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index];
    if (escaping) {
      pattern += escapeRegExpChar(ch) + zeroWidthOptional;
      hasLiteralToken = true;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === '#') {
      pattern += escapeRegExpChar(ch) + zeroWidthOptional;
      hasLiteralToken = true;
      continue;
    }
    if (ch === '*') {
      let runLength = 1;
      while (index + runLength < chars.length && chars[index + runLength] === '*') {
        runLength += 1;
      }
      index += runLength - 1;

      if (runLength === 1) {
        // `*` matches any characters on a single line (including digits, punctuation, spaces).
        pattern += wildcardAnyLength;
      } else {
        // `**`, `***`, etc match an exact character count. Useful for timestamps like `**:**:**.***`.
        pattern += `[^\\r\\n]{${runLength}}`;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\u00A0') {
      pattern += '[ \\t\\u00A0]+';
      hasLiteralToken = true;
      continue;
    }
    pattern += escapeRegExpChar(ch) + zeroWidthOptional;
    hasLiteralToken = true;
  }

  if (escaping) {
    pattern += '\\\\';
    hasLiteralToken = true;
  }

  if (!hasLiteralToken) return null;

  return new RegExp(pattern, 'gi');
}

export function hasConfiguredPhraseMatch(input: string, phrases: string[]): boolean {
  if (!phrases.length) return false;
  for (const phrase of phrases) {
    if (!phrase) continue;
    const regex = buildFlexiblePhraseRegex(phrase);
    if (!regex) continue;
    regex.lastIndex = 0;
    if (regex.test(input)) return true;
  }
  return false;
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
