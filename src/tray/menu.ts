import { Menu } from '@tauri-apps/api/menu';
import { TrayIcon } from '@tauri-apps/api/tray';
import { Image } from '@tauri-apps/api/image';
import { resolveResource } from '@tauri-apps/api/path';
import { getCachedSettings } from '../runtime/settings';

export interface TrayMenuActions {
  toggleCleaner: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  openSettings: () => Promise<void>;
  quit: () => Promise<void>;
}

const TRAY_ICON_ID = 'main';
const TRAY_ICON_RESOURCE = 'icons/hammer-cleaner-tray.png';

async function getOrCreateTrayIcon() {
  const existingTray = await TrayIcon.getById(TRAY_ICON_ID);
  if (existingTray) {
    return existingTray;
  }

  const iconPath = await resolveResource(TRAY_ICON_RESOURCE);
  const icon = await Image.fromPath(iconPath);
  return TrayIcon.new({
    id: TRAY_ICON_ID,
    icon,
    iconAsTemplate: false,
    showMenuOnLeftClick: true,
    tooltip: 'Clipboard Cleaner'
  });
}

export async function createTrayMenu(actions: TrayMenuActions) {
  let menu: Menu | null = null;
  const tray = await getOrCreateTrayIcon();

  async function updateToggleLabel() {
    if (!menu) return;
    const settings = getCachedSettings();
    const toggleItem = await menu.get('toggle');
    if (toggleItem) {
      await toggleItem.setText(settings.enabled ? 'Disable Cleaner' : 'Enable Cleaner');
    }
  }

  const toggleAction = async () => {
    await actions.toggleCleaner();
    await updateToggleLabel();
  };

  const reloadAction = async () => {
    await actions.reloadSettings();
    await updateToggleLabel();
  };

  const menuInstance = await Menu.new({
    items: [
      {
        id: 'toggle',
        text: 'Toggle Cleaner',
        action: toggleAction
      },
      {
        id: 'reload',
        text: 'Reload Settings',
        action: reloadAction
      },
      {
        id: 'settings',
        text: 'Settings\u2026',
        action: async () => {
          await actions.openSettings();
        }
      },
      {
        id: 'quit',
        text: 'Quit',
        action: async () => {
          await actions.quit();
        }
      }
    ]
  });

  menu = menuInstance;
  await tray.setMenu(menuInstance);
  await tray.setIconAsTemplate(false);
  await tray.setShowMenuOnLeftClick(true);
  await tray.setTooltip('Clipboard Cleaner');
  await tray.setVisible(true);

  await updateToggleLabel();

  return {
    refresh: updateToggleLabel,
    close: () => tray.setVisible(false)
  };
}
