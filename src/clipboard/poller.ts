import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

let running = false;
let unlisten: UnlistenFn | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<{ timestamp: string }>(LAST_CLEANED_EVENT, (event) => {
    const timestamp = event.payload?.timestamp;
    if (!timestamp) return;
    emitLastCleaned(new Date(timestamp));
  });
}

export function startPoller(): void {
  if (running) return;
  running = true;
  void ensureListener();
}

export function stopPoller(): void {
  running = false;
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
}

export function restartPoller(): void {
  stopPoller();
  startPoller();
}
