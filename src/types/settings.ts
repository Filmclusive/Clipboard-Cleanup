export interface SanitizerRuleFlags {
  collapseInlineSpacing: boolean;
  collapseBlankLines: boolean;
  removeTrailingSpaces: boolean;
  replaceNonBreakingSpaces: boolean;
  removeZeroWidthSpaces: boolean;
}

export interface Settings {
  enabled: boolean;
  pollingIntervalMs: number;
  trimWhitespace: boolean;
  showDockIcon: boolean;
  showMenuBarIcon: boolean;
  phraseFilters: string[];
  excludedApps: string[];
  ruleFlags: SanitizerRuleFlags;
}

export const defaultExcludedApps = [
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.microsoft.VSCode',
  'com.jetbrains.intellij',
  'com.apple.dt.Xcode',
  'com.apple.Xcode',
  'com.apple.TextEdit',
  'com.apple.Safari',
  'com.apple.ScriptEditor2',
  'com.agilebits.onepassword7',
  'Terminal',
  'iTerm2',
  'Code',
  'Code Helper',
  'Xcode',
  'Script Editor',
  'Safari',
  'Obsidian',
  'Visual Studio Code'
];

export const defaultRuleFlags: SanitizerRuleFlags = {
  collapseInlineSpacing: true,
  collapseBlankLines: true,
  removeTrailingSpaces: true,
  replaceNonBreakingSpaces: true,
  removeZeroWidthSpaces: true
};

export const defaultSettings: Settings = {
  enabled: true,
  pollingIntervalMs: 250,
  trimWhitespace: false,
  showDockIcon: true,
  showMenuBarIcon: true,
  phraseFilters: [],
  excludedApps: defaultExcludedApps,
  ruleFlags: defaultRuleFlags
};
