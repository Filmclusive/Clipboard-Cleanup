import { mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { Settings, defaultSettings } from '../types/settings';

const SETTINGS_FOLDER = 'clipboard-cleaner';
const SETTINGS_FILE = 'settings.json';

async function resolveSettingsPaths(): Promise<{ folderPath: string; filePath: string }> {
  // Using absolute paths avoids any scope/baseDir ambiguity and ensures parent dirs are created.
  const base = await appConfigDir();
  const folderPath = await join(base, SETTINGS_FOLDER);
  const filePath = await join(folderPath, SETTINGS_FILE);
  return { folderPath, filePath };
}

let cachedSettings: Settings = structuredClone(defaultSettings);

function copySettings(value: Settings): Settings {
  return JSON.parse(JSON.stringify(value));
}

function normalizePhraseFilters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Map<string, string>();
  value.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const trimmed = entry.trim();
    if (!trimmed) return;
    const key = trimmed.toLocaleLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, trimmed);
    }
  });
  return [...deduped.values()];
}

function normalizeLoaded(value: Partial<Settings>): Settings {
  const showDockIcon =
    typeof value.showDockIcon === 'boolean' ? value.showDockIcon : defaultSettings.showDockIcon;
  const showMenuBarIcon =
    typeof value.showMenuBarIcon === 'boolean'
      ? value.showMenuBarIcon
      : defaultSettings.showMenuBarIcon;

  const normalizedVisibility =
    showDockIcon || showMenuBarIcon
      ? { showDockIcon, showMenuBarIcon }
      : { showDockIcon: defaultSettings.showDockIcon, showMenuBarIcon: true };

  return {
    ...defaultSettings,
    ...value,
    ...normalizedVisibility,
    ruleFlags: {
      ...defaultSettings.ruleFlags,
      ...(value.ruleFlags ?? {})
    },
    excludedApps: Array.isArray(value.excludedApps)
      ? value.excludedApps
      : defaultSettings.excludedApps,
    phraseFilters: normalizePhraseFilters(value.phraseFilters)
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const { folderPath, filePath } = await resolveSettingsPaths();
    await mkdir(folderPath, { recursive: true });
    const payload = await readTextFile(filePath);
    const parsed = JSON.parse(payload) as Partial<Settings>;
    cachedSettings = normalizeLoaded(parsed);
  } catch (err) {
    console.warn('Falling back to default settings', err);
    cachedSettings = structuredClone(defaultSettings);
  }
  return copySettings(cachedSettings);
}

export function getCachedSettings(): Settings {
  return copySettings(cachedSettings);
}

export async function persistSettings(next: Settings): Promise<void> {
  try {
    const { folderPath, filePath } = await resolveSettingsPaths();
    await mkdir(folderPath, { recursive: true });
    await writeTextFile(filePath, JSON.stringify(next, null, 2));
    cachedSettings = normalizeLoaded(next);
  } catch (err) {
    console.error('Failed to persist settings', err);
    throw err;
  }
}

export async function reloadSettings(): Promise<Settings> {
  return loadSettings();
}
