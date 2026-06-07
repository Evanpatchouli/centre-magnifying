import { Menu, Tray, app, nativeImage } from 'electron'
import { showSettingsWindow } from './windows'

let tray: Tray | null = null

export function createTray(): Tray {
  if (tray) return tray

  const image = nativeImage.createFromDataURL(createTrayIconDataUrl())
  image.setTemplateImage(true)

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

function createTrayIconDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="14" cy="14" r="8" fill="none" stroke="black" stroke-width="3"/>
    <path d="M20 20 L28 28" stroke="black" stroke-width="3" stroke-linecap="round"/>
    <circle cx="14" cy="14" r="3" fill="black"/>
  </svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
