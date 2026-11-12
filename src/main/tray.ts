import { Menu, Tray, app, nativeImage } from 'electron'
import { showSettingsWindow } from './windows'
import { join } from 'node:path'

let tray: Tray | null = null

export function createTray(): Tray {
  if (tray) return tray

  const image = nativeImage.createFromPath(join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.ico'))

  tray = new Tray(image)
  tray.setToolTip('Centre Magnifying')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '设置',
        click: () => showSettingsWindow(),
      },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]),
  )

  tray.on('double-click', () => showSettingsWindow())

  return tray
}

