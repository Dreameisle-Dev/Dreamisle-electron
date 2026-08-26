import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { t } from '../shared/i18n.js';
import { getMainWindow } from './window.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray = null;

function buildTrayMenuTemplate() {
  return [
    {
      label: t('tray.playPause'),
      click: () => {
        if (getMainWindow()) getMainWindow().webContents.send('tray-play-pause');
      },
    },
    {
      label: t('tray.next'),
      click: () => {
        if (getMainWindow()) getMainWindow().webContents.send('tray-next');
      },
    },
    {
      label: t('tray.prev'),
      click: () => {
        if (getMainWindow()) getMainWindow().webContents.send('tray-prev');
      },
    },
    { type: 'separator' },
    {
      label: t('tray.showWindow'),
      click: () => {
        if (getMainWindow()) {
          getMainWindow().show();
          getMainWindow().focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: t('tray.quit'),
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ];
}

export function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
  tray.setToolTip(t('tray.tooltip'));
}

export function createTray() {
  const iconPath = path.join(__dirname, '../assets/app_icon.ico');
  const trayIcon = nativeImage.createFromPath(iconPath);

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate(buildTrayMenuTemplate());

  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (getMainWindow()) {
      if (getMainWindow().isVisible()) getMainWindow().hide();
      else {
        getMainWindow().show();
        getMainWindow().focus();
      }
    }
  });
}
