import { BaseDirectory, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { Settings, defaultSettings } from '../types/settings';

const SETTINGS_FOLDER = 'clipboard-cleaner';
const SETTINGS_FILE = 'settings.json';

let cachedSettings: Settings = structuredClone(defaultSettings);

function copySettings(value: Settings): Settings {
  return JSON.parse(JSON.stringify(value));
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
    phraseFilters: Array.isArray(value.phraseFilters) ? value.phraseFilters : []
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    await mkdir(SETTINGS_FOLDER, { dir: BaseDirectory.AppConfig, recursive: true });
    const payload = await readTextFile(`${SETTINGS_FOLDER}/${SETTINGS_FILE}`, { baseDir: BaseDirectory.AppConfig });
    const parsed = JSON.parse(payload) as Partial<Settings>;
    cachedSettings = normalizeLoaded(parsed);
  } catch (err) {
    cachedSettings = structuredClone(defaultSettings);
  }
  return copySettings(cachedSettings);
}

export function getCachedSettings(): Settings {
  return copySettings(cachedSettings);
}

export async function persistSettings(next: Settings): Promise<void> {
  try {
    await mkdir(SETTINGS_FOLDER, { dir: BaseDirectory.AppConfig, recursive: true });
    await writeTextFile(`${SETTINGS_FOLDER}/${SETTINGS_FILE}`, JSON.stringify(next, null, 2), {
      baseDir: BaseDirectory.AppConfig
    });
    cachedSettings = normalizeLoaded(next);
  } catch (err) {
    console.error('Failed to persist settings', err);
    throw err;
  }
}

export async function reloadSettings(): Promise<Settings> {
  return loadSettings();
}
