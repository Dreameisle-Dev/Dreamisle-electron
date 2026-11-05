import { app, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { t } from '../shared/i18n.js';
import { getMainWindow } from './window.js';
import { isTaskbarLyricsEnabled, setTaskbarLyricsEnabled } from '../taskbar/taskbar-lyrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray = null;

function buildTrayMenuTemplate() {
  const template = [
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
  ];

  // 任务栏歌词是 Windows 专属功能；macOS/Linux 不显示这个入口。
  if (process.platform === 'win32') {
    template.push(
      {
        type: 'checkbox',
        label: t('tray.taskbarLyrics'),
        checked: isTaskbarLyricsEnabled(),
        click: (item) => {
          setTaskbarLyricsEnabled(item.checked);
          rebuildTrayMenu();
        },
      },
      {
        label: t('tray.taskbarLyricsHotkey'),
        enabled: false,
      }
    );
  }

  template.push(
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
    }
  );

  return template;
}

export function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
  tray.setToolTip(t('tray.tooltip'));
}

export function createTray() {
  const iconName =
    process.platform === 'win32'
      ? 'app_icon.ico'
      : process.platform === 'darwin'
        ? 'trayTemplate.png'
        : 'icon_32x32.png';
  const iconPath = path.join(__dirname, '../assets', iconName);
  let trayIcon = nativeImage.createFromPath(iconPath);
  // Windows 的 ICO 需要缩到托盘尺寸；macOS/Linux 直接用标准图标。
  // macOS 使用黑色透明模板，系统会按菜单栏明暗自动反色。
  if (process.platform === 'win32') trayIcon = trayIcon.resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);

  tray = new Tray(trayIcon);

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
