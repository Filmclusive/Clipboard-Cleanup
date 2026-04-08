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
import { createTrayMenu, TrayMenuActions } from './tray/menu';
import type { SanitizerRuleFlags, Settings } from './types/settings';

type RuleKey = keyof SanitizerRuleFlags;

type InstalledApp = {
  bundleIdentifier?: string | null;
  name: string;
  iconDataUrl?: string | null;
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
let trayMenuHandle: Awaited<ReturnType<typeof createTrayMenu>> | null = null;
let trayActions: TrayMenuActions;

const rootPanel = buildPanel();
const appWindow = getCurrentWindow();
document.body.innerHTML = '';
document.body.appendChild(rootPanel);

const enabledToggle = rootPanel.querySelector<HTMLInputElement>('#enabledToggle');
const pollingIntervalInput = rootPanel.querySelector<HTMLInputElement>('#pollingInterval');
const pollingHint = rootPanel.querySelector<HTMLParagraphElement>('#pollingHint');
const rulesContainer = rootPanel.querySelector<HTMLDivElement>('#rulesContainer');
const phraseFilterInput = rootPanel.querySelector<HTMLInputElement>('#phraseFilterInput');
const addPhraseButton = rootPanel.querySelector<HTMLButtonElement>('#addPhraseButton');
const phraseFiltersList = rootPanel.querySelector<HTMLUListElement>('#phraseFiltersList');
const phraseFiltersHelper = rootPanel.querySelector<HTMLParagraphElement>('#phraseFiltersHelper');
const excludedAppsList = rootPanel.querySelector<HTMLDivElement>('#excludedAppsList');
const excludedAppsSearch = rootPanel.querySelector<HTMLInputElement>('#excludedAppsSearch');
const saveButton = rootPanel.querySelector<HTMLButtonElement>('#saveButton');
const closeButton = rootPanel.querySelector<HTMLButtonElement>('#closeButton');
const saveMessage = rootPanel.querySelector<HTMLParagraphElement>('#saveMessage');
const trimWhitespaceToggle = rootPanel.querySelector<HTMLInputElement>('#trimWhitespaceToggle');
const showDockIconToggle = rootPanel.querySelector<HTMLInputElement>('#showDockIconToggle');
const showMenuBarIconToggle = rootPanel.querySelector<HTMLInputElement>('#showMenuBarIconToggle');
const lastCleanedValue = rootPanel.querySelector<HTMLParagraphElement>('#lastCleanedValue');
const statusDot = rootPanel.querySelector<HTMLSpanElement>('[data-status-dot]');

const ruleInputs = new Map<RuleKey, HTMLInputElement>();
let installedApps: InstalledApp[] = [];

wireSidebar(rootPanel);

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
      }
    });
  }
  rulesContainer.appendChild(wrapper);
});

if (enabledToggle) {
  enabledToggle.addEventListener('change', () => {
    if (pendingSettings) {
      pendingSettings.enabled = enabledToggle.checked;
    }
  });
}

if (pollingIntervalInput) {
  pollingIntervalInput.addEventListener('input', () => {
    if (pendingSettings) {
      const raw = Number(pollingIntervalInput.value) || MIN_POLL_INTERVAL_MS;
      pendingSettings.pollingIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, raw);
      updatePollingHint(pendingSettings.pollingIntervalMs);
    }
  });
}

addPhraseButton?.addEventListener('click', () => {
  handleAddPhrase();
});

phraseFilterInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleAddPhrase();
  }
});

excludedAppsSearch?.addEventListener('input', () => {
  renderExcludedApps();
});

trimWhitespaceToggle?.addEventListener('change', () => {
  if (pendingSettings) {
    pendingSettings.trimWhitespace = trimWhitespaceToggle.checked;
  }
});

showDockIconToggle?.addEventListener('change', () => {
  if (!pendingSettings) return;
  pendingSettings.showDockIcon = showDockIconToggle.checked;
  enforceVisibilityMinimum(pendingSettings);
  syncVisibilityToggles(pendingSettings);
});

showMenuBarIconToggle?.addEventListener('change', () => {
  if (!pendingSettings) return;
  pendingSettings.showMenuBarIcon = showMenuBarIconToggle.checked;
  enforceVisibilityMinimum(pendingSettings);
  syncVisibilityToggles(pendingSettings);
});

saveButton?.addEventListener('click', () => {
  void handleSave();
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

async function handleSave() {
  if (!pendingSettings || !saveButton) return;
  saveButton.disabled = true;
  if (saveMessage) {
    saveMessage.textContent = 'Saving settings…';
  }
  try {
    const snapshot = cloneSettings(pendingSettings);
    enforceVisibilityMinimum(snapshot);
    await persistSettings(snapshot);
    pendingSettings = cloneSettings(snapshot);
    applyPollerState(pendingSettings);
    await applyVisibilityState(pendingSettings);
    trayMenuHandle?.refresh();
    if (saveMessage) {
      saveMessage.textContent = `Saved ${formatTimestamp(new Date())}`;
    }
  } catch (error) {
    console.error('Failed to save settings', error);
    if (saveMessage) {
      saveMessage.textContent = 'Could not save changes.';
    }
  } finally {
    saveButton.disabled = false;
  }
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
    .map((line) => line.trim())
    .filter(Boolean);
}

function handleAddPhrase() {
  if (!pendingSettings) return;
  const raw = phraseFilterInput?.value ?? '';
  const entries = parsePhraseInput(raw);
  if (!entries.length) {
    if (phraseFilterInput) {
      phraseFilterInput.value = '';
    }
    return;
  }
  entries.forEach((entry) => {
    if (!pendingSettings.phraseFilters.includes(entry)) {
      pendingSettings.phraseFilters.push(entry);
    }
  });
  if (phraseFilterInput) {
    phraseFilterInput.value = '';
  }
  renderPhraseFilters();
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
  renderExcludedApps();
  if (phraseFilterInput) {
    phraseFilterInput.value = '';
  }
  renderPhraseFilters();
}

async function showSettingsWindow() {
  await appWindow.show();
  await appWindow.setFocus();
}

async function bootstrap() {
  const settings = await loadSettings();
  syncUi(settings);
  applyPollerState(settings);
  void loadInstalledApps();
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
  await applyVisibilityState(settings);
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
        <div class="sidebar-actions" aria-label="Actions">
          <button type="button" id="saveButton" class="primary sidebar-save">Save settings</button>
        </div>
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
            <input type="text" id="phraseFilterInput" placeholder="Enter phrase to ignore" autocomplete="off" />
            <button type="button" class="primary" id="addPhraseButton">Add</button>
          </div>
          <p class="helper-text">
            Paste multi-line text or use double line returns and each non-empty line becomes its own filter.
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
          <p class="helper-text" id="saveMessage"></p>
          <div class="button-row">
            <button type="button" id="closeButton" class="ghost">Close window</button>
          </div>
        </footer>
      </main>
    </div>
  `;
  return container;
}

function wireSidebar(panel: HTMLElement) {
  const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-sidebar-item]'));
  const views = Array.from(panel.querySelectorAll<HTMLElement>('[data-view]'));
  if (!items.length || !views.length) return;

  const showView = (targetId: string) => {
    items.forEach((item) => {
      item.classList.toggle('is-active', item.dataset.target === targetId);
    });
    views.forEach((view) => {
      view.hidden = view.id !== targetId;
    });
  };

  items.forEach((item) => {
    item.addEventListener('click', () => {
      const targetId = item.dataset.target;
      if (targetId) showView(targetId);
    });
  });

  showView(items[0]?.dataset.target ?? views[0]?.id ?? 'view-cleaner');
}

async function loadInstalledApps() {
  try {
    installedApps = (await invoke('list_installed_apps')) as InstalledApp[];
  } catch (error) {
    console.error('Failed to load installed apps', error);
    installedApps = [];
  } finally {
    renderExcludedApps();
  }
}

function renderExcludedApps() {
  if (!excludedAppsList) return;

  const query = excludedAppsSearch?.value?.trim().toLowerCase() ?? '';
  const excluded = new Set((pendingSettings?.excludedApps ?? []).map((value) => value.toLowerCase()));

  excludedAppsList.innerHTML = '';

  if (!installedApps.length) {
    const empty = document.createElement('p');
    empty.className = 'helper-text';
    empty.textContent = 'No applications found to display.';
    excludedAppsList.appendChild(empty);
    return;
  }

  const filtered = installedApps.filter((app) => {
    if (!query) return true;
    const name = app.name?.toLowerCase() ?? '';
    const bundle = app.bundleIdentifier?.toLowerCase() ?? '';
    return name.includes(query) || bundle.includes(query);
  });

  filtered.forEach((app) => {
    const identifier = (app.bundleIdentifier || app.name).trim();
    const key = identifier.toLowerCase();
    const isExcluded = excluded.has(key);

    const row = document.createElement('div');
    row.className = 'app-row';

    const icon = document.createElement('div');
    icon.className = 'app-icon';
    if (app.iconDataUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = app.iconDataUrl;
      img.loading = 'lazy';
      icon.appendChild(img);
    } else {
      icon.textContent = app.name.slice(0, 1).toUpperCase();
    }

    const meta = document.createElement('div');
    meta.className = 'app-meta';
    const title = document.createElement('p');
    title.className = 'app-name';
    title.textContent = app.name;
    const subtitle = document.createElement('p');
    subtitle.className = 'app-subtitle';
    subtitle.textContent = app.bundleIdentifier ?? 'App';
    meta.appendChild(title);
    meta.appendChild(subtitle);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'app-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = isExcluded;
    toggle.setAttribute('aria-label', `Exclude ${app.name}`);
    toggle.addEventListener('change', () => {
      if (!pendingSettings) return;
      const normalized = identifier.trim();
      const normalizedKey = normalized.toLowerCase();
      const next = pendingSettings.excludedApps.filter(
        (entry) => entry.toLowerCase() !== normalizedKey
      );
      if (toggle.checked) {
        next.push(normalized);
      }
      pendingSettings.excludedApps = next;
    });
    toggleLabel.appendChild(toggle);

    row.appendChild(icon);
    row.appendChild(meta);
    row.appendChild(toggleLabel);
    excludedAppsList.appendChild(row);
  });
}
