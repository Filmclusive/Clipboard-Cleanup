import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import { getCachedSettings } from '../runtime/settings';
import { sanitizeClipboardText } from './sanitizer';
import { computeSignature } from './signature';
import { isAppExcluded, FrontmostAppInfo } from '../runtime/exclusions';

export const LAST_CLEANED_EVENT = 'clipboard-cleaner:last-cleaned';

let lastCleanedAt: Date | null = null;

export function getLastCleanedTime(): Date | null {
  return lastCleanedAt;
}

function emitLastCleaned(date: Date): void {
  lastCleanedAt = date;
  window.dispatchEvent(
    new CustomEvent(LAST_CLEANED_EVENT, { detail: { timestamp: date.toISOString() } })
  );
}

let timer: number | null = null;
let running = false;
let lastRawSignature = '';
let lastWrittenSignature = '';

async function getFrontmostApp(): Promise<FrontmostAppInfo> {
  try {
    const payload = (await invoke('get_frontmost_app')) as FrontmostAppInfo;
    return payload;
  } catch (err) {
    console.error('Failed to fetch frontmost app', err);
    return { bundleIdentifier: null, name: null };
  }
}

async function pollOnce(): Promise<void> {
  if (!running) return;
  const settings = getCachedSettings();

  if (!settings.enabled) {
    return;
  }

  try {
    const clipboardText = await readText();
    const rawValue = clipboardText ?? '';
    const rawSignature = computeSignature(rawValue);
    if (rawSignature === lastRawSignature) {
      return;
    }
    lastRawSignature = rawSignature;

    const frontmost = await getFrontmostApp();
    if (isAppExcluded(frontmost, settings)) {
      return;
    }

    const cleaned = sanitizeClipboardText(rawValue, settings);
    const cleanedSignature = computeSignature(cleaned);

    if (cleanedSignature === lastWrittenSignature) {
      return;
    }

    if (cleaned !== rawValue) {
      await writeText(cleaned);
      lastWrittenSignature = cleanedSignature;
      emitLastCleaned(new Date());
    }
  } catch (err) {
    console.error('Clipboard poll failed', err);
  }
}

function scheduleNext(): void {
  if (!running) return;
  const interval = Math.max(getCachedSettings().pollingIntervalMs, 50);
  timer = window.setTimeout(async () => {
    await pollOnce();
    scheduleNext();
  }, interval);
}

export function startPoller(): void {
  if (running) return;
  running = true;
  scheduleNext();
}

export function stopPoller(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function restartPoller(): void {
  stopPoller();
  lastRawSignature = '';
  lastWrittenSignature = '';
  startPoller();
}
