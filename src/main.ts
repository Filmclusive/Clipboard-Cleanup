import './styles.css';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { loadSettings, persistSettings, reloadSettings } from './runtime/settings';
import {
  stopPoller,
  restartPoller,
  LAST_CLEANED_EVENT,
  getLastCleanedTime
} from './clipboard/poller';
import type { SanitizerRuleFlags, Settings } from './types/settings';

type RuleKey = keyof SanitizerRuleFlags;

type TrayMenuActions = {
  toggleCleaner: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  openSettings: () => Promise<void>;
  quit: () => Promise<void>;
};

type TrayMenuHandle = {
  refresh: () => Promise<void>;
  close: () => Promise<void>;
};

const SANITIZER_RULES: Array<{ key: RuleKey; title: string; description: string }> = [
  {
    key: 'collapseInlineSpacing',
    title: 'Collapse inline spacing',
    description: 'Reduce repeated spaces inside a line so pasted text stays compact.'
  },
  {
    key: 'collapseBlankLines',
    title: 'Collapse blank lines',
    description: 'Squash consecutive blank lines into a single empty line.'
  },
  {
    key: 'removeTrailingSpaces',
    title: 'Remove trailing spaces',
    description: 'Strip spaces at the end of each line before saving to clipboard.'
  },
  {
    key: 'replaceNonBreakingSpaces',
    title: 'Replace non-breaking spaces',
    description: 'Swap nbsp characters with regular spaces to avoid layout issues.'
  },
  {
    key: 'removeZeroWidthSpaces',
    title: 'Remove zero-width spaces',
    description: 'Drop stealthy zero-width characters that break pasting.'
  }
];

const MIN_POLL_INTERVAL_MS = 50;

let pendingSettings: Settings | null = null;
let trayMenuHandle: TrayMenuHandle | null = null;
let trayActions: TrayMenuActions;

const rootPanel = buildPanel();
const appWindow = getCurrentWindow();
document.body.innerHTML = '';
document.body.appendChild(rootPanel);

const enabledToggle = rootPanel.querySelector<HTMLInputElement>('#enabledToggle');
const pollingIntervalInput = rootPanel.querySelector<HTMLInputElement>('#pollingInterval');
const pollingHint = rootPanel.querySelector<HTMLParagraphElement>('#pollingHint');
const rulesContainer = rootPanel.querySelector<HTMLDivElement>('#rulesContainer');
const phraseFilterInput = rootPanel.querySelector<HTMLTextAreaElement>('#phraseFilterInput');
const addPhraseButton = rootPanel.querySelector<HTMLButtonElement>('#addPhraseButton');
const phraseFiltersList = rootPanel.querySelector<HTMLUListElement>('#phraseFiltersList');
const phraseFiltersHelper = rootPanel.querySelector<HTMLParagraphElement>('#phraseFiltersHelper');
const excludedAppsList = rootPanel.querySelector<HTMLDivElement>('#excludedAppsList');
const excludedAppsSearch = rootPanel.querySelector<HTMLInputElement>('#excludedAppsSearch');
const closeButton = rootPanel.querySelector<HTMLButtonElement>('#closeButton');
const trimWhitespaceToggle = rootPanel.querySelector<HTMLInputElement>('#trimWhitespaceToggle');
const showDockIconToggle = rootPanel.querySelector<HTMLInputElement>('#showDockIconToggle');
const showMenuBarIconToggle = rootPanel.querySelector<HTMLInputElement>('#showMenuBarIconToggle');
const lastCleanedValue = rootPanel.querySelector<HTMLParagraphElement>('#lastCleanedValue');
const statusDot = rootPanel.querySelector<HTMLSpanElement>('[data-status-dot]');
const saveStatus = rootPanel.querySelector<HTMLParagraphElement>('#saveStatus');

const ruleInputs = new Map<RuleKey, HTMLInputElement>();

const sidebarApi = wireSidebar(rootPanel, (targetId) => {
  if (targetId === 'view-apps') {
    ensureExcludedAppsApi()?.ensureLoaded();
  }
});

SANITIZER_RULES.forEach((rule) => {
  if (!rulesContainer) return;
  const wrapper = document.createElement('label');
  wrapper.className = 'rule-toggle';
  wrapper.htmlFor = `ruleSwitch:${rule.key}`;
  wrapper.innerHTML = `
    <div>
      <p class="rule-title">${rule.title}</p>
      <p class="rule-description">${rule.description}</p>
    </div>
    <input type="checkbox" id="ruleSwitch:${rule.key}" />
  `;
  const input = wrapper.querySelector<HTMLInputElement>('input');
    if (input) {
      ruleInputs.set(rule.key, input);
      input.addEventListener('change', () => {
        if (pendingSettings) {
          pendingSettings.ruleFlags[rule.key] = input.checked;
          scheduleAutoSave();
        }
      });
    }
  rulesContainer.appendChild(wrapper);
});

if (enabledToggle) {
  enabledToggle.addEventListener('change', () => {
    if (pendingSettings) {
      pendingSettings.enabled = enabledToggle.checked;
      scheduleAutoSave();
    }
  });
}

if (pollingIntervalInput) {
  pollingIntervalInput.addEventListener('input', () => {
    if (pendingSettings) {
      const raw = Number(pollingIntervalInput.value) || MIN_POLL_INTERVAL_MS;
      pendingSettings.pollingIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, raw);
      updatePollingHint(pendingSettings.pollingIntervalMs);
      scheduleAutoSave();
    }
  });
}

addPhraseButton?.addEventListener('click', () => {
  handleAddPhrase();
});

phraseFilterInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    handleAddPhrase();
  }
});

excludedAppsSearch?.addEventListener('input', () => {
  excludedAppsApi?.render();
});

trimWhitespaceToggle?.addEventListener('change', () => {
  if (pendingSettings) {
    pendingSettings.trimWhitespace = trimWhitespaceToggle.checked;
    scheduleAutoSave();
  }
});

showDockIconToggle?.addEventListener('change', () => {
  if (!pendingSettings) return;
  pendingSettings.showDockIcon = showDockIconToggle.checked;
  enforceVisibilityMinimum(pendingSettings);
  syncVisibilityToggles(pendingSettings);
  scheduleAutoSave();
});

showMenuBarIconToggle?.addEventListener('change', () => {
  if (!pendingSettings) return;
  pendingSettings.showMenuBarIcon = showMenuBarIconToggle.checked;
  enforceVisibilityMinimum(pendingSettings);
  syncVisibilityToggles(pendingSettings);
  scheduleAutoSave();
});

closeButton?.addEventListener('click', () => {
  void appWindow.hide();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    void appWindow.hide();
  }
});

window.addEventListener(LAST_CLEANED_EVENT, (event) => {
  const detail = (event as CustomEvent<{ timestamp: string }>).detail;
  updateStatus(detail.timestamp);
});

updateStatus(getLastCleanedTime()?.toISOString());

const autoSaveState = { queued: false, running: false };

function scheduleAutoSave() {
  if (autoSaveState.running) {
    autoSaveState.queued = true;
    return;
  }
  autoSaveState.running = true;
  void persistPendingChanges().finally(() => {
    autoSaveState.running = false;
    if (autoSaveState.queued) {
      autoSaveState.queued = false;
      scheduleAutoSave();
    }
  });
}

async function persistPendingChanges() {
  if (!pendingSettings) return;
  const snapshot = cloneSettings(pendingSettings);
  try {
    await persistAndSyncSettings(snapshot);
    if (saveStatus) {
      saveStatus.textContent = '';
    }
  } catch (error) {
    console.error('Auto-save failed', error);
    if (saveStatus) {
      saveStatus.textContent = 'Save failed; see console.';
    }
  }
}

async function persistAndSyncSettings(snapshot: Settings) {
  enforceVisibilityMinimum(snapshot);
  await persistSettings(snapshot);
  pendingSettings = cloneSettings(snapshot);
  applyPollerState(pendingSettings);
  await applyVisibilityState(pendingSettings);
  trayMenuHandle?.refresh();
}

function applyPollerState(settings: Settings) {
  if (settings.enabled) {
    restartPoller();
  } else {
    stopPoller();
  }
}

function enforceVisibilityMinimum(settings: Settings) {
  if (!settings.showDockIcon && !settings.showMenuBarIcon) {
    settings.showMenuBarIcon = true;
  }
}

function syncVisibilityToggles(settings: Settings) {
  if (showDockIconToggle) {
    showDockIconToggle.checked = settings.showDockIcon;
  }
  if (showMenuBarIconToggle) {
    showMenuBarIconToggle.checked = settings.showMenuBarIcon;
  }
}

async function applyVisibilityState(settings: Settings) {
  try {
    await invoke('set_dock_icon_visible', { visible: settings.showDockIcon });
  } catch (error) {
    console.warn('Failed to update dock visibility', error);
  }

  if (settings.showMenuBarIcon) {
    if (!trayMenuHandle) {
      const { createTrayMenu } = await import('./tray/menu');
      trayMenuHandle = await createTrayMenu(trayActions);
      trayMenuHandle.refresh();
    }
  } else if (trayMenuHandle) {
    await trayMenuHandle.close();
    trayMenuHandle = null;
  }
}

function updateStatus(timestamp?: string) {
  if (!lastCleanedValue || !statusDot) return;
  if (timestamp) {
    statusDot.classList.add('is-active');
    statusDot.setAttribute('aria-label', 'cleaned recently');
    lastCleanedValue.textContent = formatRelativeTime(new Date(timestamp));
  } else {
    statusDot.classList.remove('is-active');
    statusDot.setAttribute('aria-label', 'no clean yet logged');
    lastCleanedValue.textContent = 'Not cleaned yet';
  }
}

function updatePollingHint(value: number) {
  if (!pollingHint) return;
  pollingHint.textContent = `Current target ${value} ms (${describeInterval(value)}).`;
}

function parsePhraseInput(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
}

function handleAddPhrase() {
  const settings = pendingSettings;
  if (!settings) return;
  const raw = phraseFilterInput?.value ?? '';
  const entries = parsePhraseInput(raw);
  if (!entries.length) {
    if (phraseFilterInput) {
      phraseFilterInput.value = '';
    }
    return;
  }
  const existingKeys = new Set(
    settings.phraseFilters.map((phrase) => phrase.trim().toLocaleLowerCase())
  );
  entries.forEach((entry) => {
    const key = entry.toLocaleLowerCase();
    if (!existingKeys.has(key)) {
      settings.phraseFilters.push(entry);
      existingKeys.add(key);
    }
  });
  if (phraseFilterInput) {
    phraseFilterInput.value = '';
  }
  renderPhraseFilters();
  scheduleAutoSave();
}

function renderPhraseFilters() {
  if (!phraseFiltersList) return;
  const filters = pendingSettings?.phraseFilters ?? [];
  phraseFiltersList.innerHTML = '';
  if (!filters.length) {
    const emptyItem = document.createElement('li');
    emptyItem.className = 'helper-text phrase-filter-empty';
    emptyItem.textContent = 'No filters saved yet.';
    phraseFiltersList.appendChild(emptyItem);
  } else {
    filters.forEach((phrase, index) => {
      const item = document.createElement('li');
      item.className = 'phrase-filter-item';
      const label = document.createElement('span');
      label.textContent = phrase;
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'ghost phrase-filter-remove';
      removeButton.textContent = 'Remove';
      removeButton.addEventListener('click', () => {
        pendingSettings?.phraseFilters.splice(index, 1);
        renderPhraseFilters();
        scheduleAutoSave();
      });
      item.append(label, removeButton);
      phraseFiltersList.appendChild(item);
    });
  }
  updatePhraseFiltersHelper();
}

function updatePhraseFiltersHelper() {
  if (!phraseFiltersHelper || !pendingSettings) return;
  const count = pendingSettings.phraseFilters.length;
  phraseFiltersHelper.textContent = count
    ? `You have ${count} phrase filter${count === 1 ? '' : 's'} saved.`
    : 'Add a phrase filter above to keep it from being altered automatically.';
}

function describeInterval(ms: number) {
  if (ms < 1000) {
    return `${ms} ms between polls`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1).replace(/\\.0$/, '')} s between polls`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} min between polls`;
}

function formatRelativeTime(date: Date) {
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return 'Just a moment ago';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`;
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTimestamp(date: Date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function cloneSettings(value: Settings): Settings {
  return JSON.parse(JSON.stringify(value)) as Settings;
}

function syncUi(settings: Settings) {
  pendingSettings = cloneSettings(settings);
  if (enabledToggle) {
    enabledToggle.checked = settings.enabled;
  }
  if (pollingIntervalInput) {
    pollingIntervalInput.value = String(settings.pollingIntervalMs);
    updatePollingHint(settings.pollingIntervalMs);
  }
  ruleInputs.forEach((input, key) => {
    input.checked = Boolean(settings.ruleFlags[key]);
  });
  if (trimWhitespaceToggle) {
    trimWhitespaceToggle.checked = settings.trimWhitespace;
  }
  syncVisibilityToggles(settings);
  excludedAppsApi?.render();
  if (phraseFilterInput) {
    phraseFilterInput.value = '';
  }
  renderPhraseFilters();
}

async function showSettingsWindow() {
  if (await appWindow.isMinimized()) {
    await appWindow.unminimize();
  }
  await appWindow.show();
  await appWindow.setFocus();
}

async function bootstrap() {
  const settings = await loadSettings();
  syncUi(settings);
  applyPollerState(settings);
  trayActions = {
    toggleCleaner: async () => {
      const current = await reloadSettings();
      const next = { ...current, enabled: !current.enabled };
      await persistSettings(next);
      applyPollerState(next);
      trayMenuHandle?.refresh();
      syncUi(next);
    },
    reloadSettings: async () => {
      const loaded = await reloadSettings();
      applyPollerState(loaded);
      syncUi(loaded);
      trayMenuHandle?.refresh();
    },
    openSettings: showSettingsWindow,
    quit: async () => {
      await invoke('exit_app');
    }
  };
  // Don't block initial window render on tray/menu setup.
  requestAnimationFrame(() => {
    void applyVisibilityState(settings);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap clipboard cleaner', error);
});

function buildPanel() {
  const container = document.createElement('div');
  container.className = 'settings-shell';
  container.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Settings categories">
        <div class="sidebar-header">
          <p class="sidebar-app">Clipboard Cleaner</p>
        </div>
        <nav class="sidebar-nav">
          <button type="button" class="sidebar-item is-active" data-sidebar-item data-target="view-cleaner">Cleaner</button>
          <button type="button" class="sidebar-item" data-sidebar-item data-target="view-rules">Rules</button>
          <button type="button" class="sidebar-item" data-sidebar-item data-target="view-filters">Filters</button>
          <button type="button" class="sidebar-item" data-sidebar-item data-target="view-apps">Excluded apps</button>
          <button type="button" class="sidebar-item" data-sidebar-item data-target="view-background">Background</button>
        </nav>
        <div class="sidebar-footer">
          <div class="status-row is-compact" aria-label="Cleaner status">
            <span class="status-dot" data-status-dot></span>
            <div class="status-copy">
              <p class="status-label">Last cleaned</p>
              <p class="status-value" id="lastCleanedValue">Not cleaned yet</p>
            </div>
          </div>
        </div>
      </aside>
      <main class="content" aria-label="Settings detail">
        <header class="content-header">
          <div>
            <p class="content-kicker">Settings</p>
            <h1 class="content-title">Clipboard Cleaner</h1>
          </div>
        </header>

        <section class="panel-section" data-view id="view-cleaner">
          <div class="section-heading">
            <p class="section-title">Cleaner</p>
            <p class="helper-text">Enable the cleaner and tune how frequently it checks for clipboard changes.</p>
          </div>
          <label class="toggle-row" for="enabledToggle">
            <span>Cleaner enabled</span>
            <input type="checkbox" id="enabledToggle" />
          </label>
          <label class="field-group" for="pollingInterval">
            <span class="field-label">Polling interval</span>
            <div class="input-with-suffix">
              <input type="number" id="pollingInterval" min="${MIN_POLL_INTERVAL_MS}" step="10" />
              <span class="input-suffix">ms</span>
            </div>
            <p class="helper-text" id="pollingHint"></p>
          </label>
          <label class="toggle-row" for="trimWhitespaceToggle">
            <span>Trim clipboard whitespace</span>
            <input type="checkbox" id="trimWhitespaceToggle" />
          </label>
          <p class="helper-text">Remove leading/trailing whitespace after sanitization.</p>
        </section>

        <section class="panel-section" data-view id="view-rules" hidden>
          <div class="section-heading">
            <p class="section-title">Sanitizer rules</p>
            <p class="helper-text">Toggle individual cleanup rules that match your workflow.</p>
          </div>
          <div id="rulesContainer" class="rule-grid"></div>
        </section>

        <section class="panel-section" data-view id="view-filters" hidden>
          <div class="section-heading">
            <p class="section-title">Phrase filters</p>
            <p class="helper-text">
              Add each phrase individually so the cleaner can check them one by one.
            </p>
          </div>
        <div class="filter-input-row">
            <textarea id="phraseFilterInput" rows="3" placeholder="Enter phrase to ignore" autocomplete="off"></textarea>
            <button type="button" class="primary" id="addPhraseButton">Add</button>
          </div>
          <p class="helper-text">
            Paste multi-line text or use double line returns and each non-empty line becomes its own filter.
          </p>
          <p class="helper-text">
            Add the filters by pressing ⌘/Ctrl + Enter so you can keep typing while copying multi-line snippets.
          </p>
          <p class="helper-text">
            Filters match the exact characters you paste—indentation, pipes, and spaces all count—so copy the snippet straight from the log.
          </p>
          <p class="helper-text" id="phraseFiltersHelper"></p>
          <ul id="phraseFiltersList" class="phrase-filter-list" aria-live="polite"></ul>
        </section>

        <section class="panel-section" data-view id="view-apps" hidden>
          <div class="section-heading">
            <p class="section-title">Excluded apps</p>
            <p class="helper-text">Exclude specific apps so their clipboard changes are never modified.</p>
          </div>
          <label class="field-group" for="excludedAppsSearch">
            <span class="field-label">Search</span>
            <input type="text" id="excludedAppsSearch" placeholder="Search Applications" />
          </label>
          <div id="excludedAppsList" class="app-list" aria-label="Applications list"></div>
        </section>

        <section class="panel-section" data-view id="view-background" hidden>
          <div class="section-heading">
            <p class="section-title">Background</p>
            <p class="helper-text">Choose where the app appears while it runs.</p>
          </div>
          <label class="toggle-row" for="showDockIconToggle">
            <span>Show in Dock</span>
            <input type="checkbox" id="showDockIconToggle" />
          </label>
          <label class="toggle-row" for="showMenuBarIconToggle">
            <span>Show menu bar icon</span>
            <input type="checkbox" id="showMenuBarIconToggle" />
          </label>
          <p class="helper-text">At least one option stays enabled so you can reopen settings.</p>
        </section>

        <footer class="panel-footer">
          <div class="button-row">
            <button type="button" id="closeButton" class="ghost">Close window</button>
          </div>
          <p class="helper-text" id="saveStatus" aria-live="polite"></p>
        </footer>
      </main>
    </div>
  `;
  return container;
}

function wireSidebar(panel: HTMLElement, onShowView?: (targetId: string) => void) {
  const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-sidebar-item]'));
  const views = Array.from(panel.querySelectorAll<HTMLElement>('[data-view]'));
  if (!items.length || !views.length) return { showView: (_targetId: string) => {} };

  const showView = (targetId: string) => {
    items.forEach((item) => {
      item.classList.toggle('is-active', item.dataset.target === targetId);
    });
    views.forEach((view) => {
      view.hidden = view.id !== targetId;
    });
    onShowView?.(targetId);
  };

  items.forEach((item) => {
    item.addEventListener('click', () => {
      const targetId = item.dataset.target;
      if (targetId) showView(targetId);
    });
  });

  showView(items[0]?.dataset.target ?? views[0]?.id ?? 'view-cleaner');

  return { showView };
}

let excludedAppsApi: null | { ensureLoaded: () => void; render: () => void } = null;

function ensureExcludedAppsApi() {
  if (excludedAppsApi) return excludedAppsApi;
  if (!excludedAppsList) return null;

  excludedAppsApi = {
    ensureLoaded: () => {
      void (async () => {
        const mod = await import('./views/excluded-apps');
        excludedAppsApi = mod.initExcludedApps({
          listEl: excludedAppsList,
          searchEl: excludedAppsSearch ?? null,
          getSettings: () => pendingSettings,
          setExcludedApps: (next) => {
            if (!pendingSettings) return;
            pendingSettings.excludedApps = next;
            scheduleAutoSave();
          }
        });
        excludedAppsApi.ensureLoaded();
      })();
    },
    render: () => {
      // Before the module is loaded, show a lightweight placeholder.
      if (!excludedAppsList) return;
      excludedAppsList.innerHTML = '';
      const placeholder = document.createElement('p');
      placeholder.className = 'helper-text';
      placeholder.textContent = 'Open this tab to load installed apps.';
      excludedAppsList.appendChild(placeholder);
    }
  };

  return excludedAppsApi;
}

// Lazy-load expensive installed-app scanning only when the user opens the tab.
const excludedApi = ensureExcludedAppsApi();
excludedApi?.render();
void sidebarApi;
