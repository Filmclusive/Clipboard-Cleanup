import { Menu } from '@tauri-apps/api/menu';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCachedSettings } from '../runtime/settings';

export interface TrayMenuActions {
  toggleCleaner: () => Promise<void>;
  reloadSettings: () => Promise<void>;
  openSettings: () => Promise<void>;
  quit: () => Promise<void>;
}

export async function createTrayMenu(actions: TrayMenuActions) {
  let menu: Menu | null = null;
  const tray = await TrayIcon.getById('main');
  if (!tray) {
    throw new Error('Tray icon not found. Ensure app.trayIcon is configured.');
  }

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
  await tray.setShowMenuOnLeftClick(true);
  await tray.setTooltip('Clipboard Cleaner');
  await tray.setVisible(true);

  await updateToggleLabel();

  return {
    refresh: updateToggleLabel,
    close: () => tray.setVisible(false)
  };
}
