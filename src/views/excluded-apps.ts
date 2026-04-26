import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../types/settings';

type InstalledApp = {
  bundleIdentifier?: string | null;
  name: string;
  iconDataUrl?: string | null;
};

type CachedApp = {
  bundleIdentifier?: string | null;
  name: string;
};

type InitArgs = {
  listEl: HTMLDivElement;
  searchEl: HTMLInputElement | null;
  getSettings: () => Settings | null;
  setExcludedApps: (next: string[]) => void;
};

type AppRow = {
  key: string;
  identifier: string;
  name: string;
  bundle: string;
  element: HTMLDivElement;
  toggle: HTMLInputElement;
};

const CACHE_KEY = 'clipboard-cleaner-excluded-apps';
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BUILD_BATCH_SIZE = 40;

function loadCachedApps(): InstalledApp[] | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: { version: string; timestamp: number; apps: CachedApp[] } = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION) return null;
    if (Date.now() - parsed.timestamp > CACHE_TTL_MS) return null;
    return parsed.apps.map((entry) => ({
      name: entry.name,
      bundleIdentifier: entry.bundleIdentifier ?? null,
      iconDataUrl: null
    }));
  } catch (error) {
    console.warn('Unable to read cached installed apps', error);
    return null;
  }
}

function storeCachedApps(apps: InstalledApp[]) {
  try {
    const payload = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      apps: apps.map(({ name, bundleIdentifier }) => ({
        name,
        bundleIdentifier: bundleIdentifier ?? null
      }))
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Unable to cache installed apps', error);
  }
}

const createHelper = (text: string) => {
  const helper = document.createElement('p');
  helper.className = 'helper-text';
  helper.textContent = text;
  return helper;
};

export function initExcludedApps(args: InitArgs) {
  let installedApps: InstalledApp[] | null = loadCachedApps();
  let hasFetchedRemoteApps = false;
  let loading = false;
  let loadedOnce = Boolean(installedApps);
  let rowCache: AppRow[] = [];
  let rowsReady = false;
  let buildingRows = false;
  let listHasRows = false;
  let emptyHelper: HTMLParagraphElement | null = null;
  let buildFrameId: number | null = null;

  const clearRows = () => {
    rowCache = [];
    rowsReady = false;
    listHasRows = false;
    buildingRows = false;
    if (buildFrameId) {
      cancelAnimationFrame(buildFrameId);
      buildFrameId = null;
    }
  };

  const ensureEmptyHelperAppended = () => {
    if (!emptyHelper) {
      emptyHelper = document.createElement('p');
      emptyHelper.className = 'helper-text';
    }
    if (!args.listEl.contains(emptyHelper)) {
      args.listEl.appendChild(emptyHelper);
    }
    emptyHelper.hidden = true;
  };

  const normalizeIdentifier = (app: InstalledApp) => (app.bundleIdentifier || app.name).trim();

  const createAppRow = (app: InstalledApp): AppRow => {
    const identifier = normalizeIdentifier(app);
    const key = identifier.toLowerCase();
    const bundle = app.bundleIdentifier ?? 'App';

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
    subtitle.textContent = bundle;
    meta.appendChild(title);
    meta.appendChild(subtitle);

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'app-toggle';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('aria-label', `Exclude ${app.name}`);
    toggle.addEventListener('change', () => {
      const normalized = identifier.trim();
      const normalizedKey = normalized.toLowerCase();
      const current = args.getSettings()?.excludedApps ?? [];
      const next = current.filter((entry) => entry.toLowerCase() !== normalizedKey);
      if (toggle.checked) {
        next.push(normalized);
      }
      args.setExcludedApps(next);
    });
    toggleLabel.appendChild(toggle);

    row.appendChild(icon);
    row.appendChild(meta);
    row.appendChild(toggleLabel);

    return { key, identifier, name: app.name, bundle, element: row, toggle };
  };

  const showStatus = (text: string) => {
    clearRows();
    args.listEl.innerHTML = '';
    const helper = createHelper(text);
    args.listEl.appendChild(helper);
  };

  const startBuildingRows = () => {
    if (!installedApps || rowsReady || buildingRows) return;
    clearRows();
    buildingRows = true;
    args.listEl.innerHTML = '';
    const status = createHelper('Preparing installed applications…');
    args.listEl.appendChild(status);
    let index = 0;

    const appendChunk = () => {
      const fragment = document.createDocumentFragment();
      const end = Math.min(installedApps!.length, index + BUILD_BATCH_SIZE);
      for (; index < end; index++) {
        const row = createAppRow(installedApps![index]);
        rowCache.push(row);
        fragment.appendChild(row.element);
      }

      if (fragment.childNodes.length) {
        if (status.parentElement) {
          status.remove();
        }
        args.listEl.appendChild(fragment);
        listHasRows = true;
      }

      if (index < installedApps!.length) {
        buildFrameId = requestAnimationFrame(appendChunk);
      } else {
        buildingRows = false;
        rowsReady = true;
        buildFrameId = null;
        ensureEmptyHelperAppended();
        render();
      }
    };

    buildFrameId = requestAnimationFrame(appendChunk);
  };

  const renderRows = () => {
    if (!emptyHelper) return;
    const query = args.searchEl?.value?.trim().toLowerCase() ?? '';
    const excluded = new Set((args.getSettings()?.excludedApps ?? []).map((value) => value.toLowerCase()));
    let visibleCount = 0;

    rowCache.forEach((row) => {
      const matches =
        !query || row.name.toLowerCase().includes(query) || row.bundle.toLowerCase().includes(query);
      row.element.hidden = !matches;
      if (matches) visibleCount += 1;
      const shouldCheck = excluded.has(row.key);
      if (row.toggle.checked !== shouldCheck) {
        row.toggle.checked = shouldCheck;
      }
    });

    emptyHelper.textContent = query ? 'No matching applications.' : 'No applications found to display.';
    emptyHelper.hidden = visibleCount > 0;
  };

  const render = () => {
    if (loading && !installedApps) {
      showStatus('Loading installed applications…');
      return;
    }

    if (!installedApps) {
      const message = loadedOnce
        ? 'No applications found to display.'
        : 'Open this tab to load installed apps.';
      showStatus(message);
      return;
    }

    if (!installedApps.length) {
      showStatus('No applications found to display.');
      return;
    }

    if (!rowsReady) {
      if (!buildingRows) {
        startBuildingRows();
      }
      return;
    }

    if (!listHasRows) {
      args.listEl.innerHTML = '';
      const fragment = document.createDocumentFragment();
      rowCache.forEach((row) => fragment.appendChild(row.element));
      args.listEl.appendChild(fragment);
      ensureEmptyHelperAppended();
      listHasRows = true;
    }

    renderRows();
  };

  const ensureLoaded = () => {
    if (hasFetchedRemoteApps || loading) return;
    loading = true;
    render();

    requestAnimationFrame(() => {
      void (async () => {
        try {
          const apps = (await invoke('list_installed_apps')) as InstalledApp[];
          installedApps = apps;
          storeCachedApps(apps);
          hasFetchedRemoteApps = true;
          loadedOnce = true;
          clearRows();
        } catch (error) {
          console.error('Failed to load installed apps', error);
          installedApps = installedApps ?? [];
          hasFetchedRemoteApps = true;
          loadedOnce = true;
        } finally {
          loading = false;
          render();
        }
      })();
    });
  };

  args.searchEl?.addEventListener('input', () => {
    if (rowsReady) {
      render();
    }
  });

  return { ensureLoaded, render };
}
