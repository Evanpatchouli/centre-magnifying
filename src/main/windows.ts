import { BrowserWindow, app, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { getSettings } from './store'
import type { MagnifierSettings } from './types'
import { isNativeCaptureRunning } from './native-capture'

let magnifierWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL

function preloadPath(): string {
  return join(__dirname, '../preload/index.mjs')
}

function rendererDevPageUrl(page: 'magnifier' | 'settings'): string {
  return `${rendererDevUrl?.replace(/\/$/, '')}/${page}/index.html`
}

export function createMagnifierWindow(): BrowserWindow {
  if (magnifierWindow && !magnifierWindow.isDestroyed()) {
    return magnifierWindow
  }

  const settings = getSettings()
  const size = getMagnifierWindowSize(settings)

  magnifierWindow = new BrowserWindow({
    width: size,
    height: size,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  magnifierWindow.setIgnoreMouseEvents(true, { forward: true })
  magnifierWindow.setAlwaysOnTop(true, 'screen-saver')
  magnifierWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  forwardWebGLProbeLogs(magnifierWindow, 'magnifier')

  if (is.dev && rendererDevUrl) {
    void magnifierWindow.loadURL(rendererDevPageUrl('magnifier'))
  } else {
    void magnifierWindow.loadFile(join(__dirname, '../renderer/magnifier/index.html'))
  }

  magnifierWindow.once('ready-to-show', () => {
    updateMagnifierWindowBounds(getSettings())
    if (!isNativeCaptureRunning()) magnifierWindow?.showInactive()
  })

  magnifierWindow.on('closed', () => {
    magnifierWindow = null
  })

  return magnifierWindow
}

export function showSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 900,
    minWidth: 900,
    minHeight: 900,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#ffffff', symbolColor: '#40516a', height: 46 },
    icon: join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'resources', 'icon.ico'),
    title: '设置 - Centre Magnifying',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (is.dev && rendererDevUrl) {
    void settingsWindow.loadURL(rendererDevPageUrl('settings'))
  } else {
    void settingsWindow.loadFile(join(__dirname, '../renderer/settings/index.html'))
  }

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  return settingsWindow
}

export function getMagnifierWindow(): BrowserWindow | null {
  return magnifierWindow && !magnifierWindow.isDestroyed() ? magnifierWindow : null
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null
}

export function updateMagnifierWindowBounds(settings: MagnifierSettings): void {
  const win = getMagnifierWindow()
  if (!win) return

  const size = getMagnifierWindowSize(settings)
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.bounds

  win.setBounds({
    width: size,
    height: size,
    x: Math.round(x + width / 2 - size / 2),
    y: Math.round(y + height / 2 - size / 2),
  })

  win.setShape?.([{ x: 0, y: 0, width: size, height: size }])
}

function getMagnifierWindowSize(settings: MagnifierSettings): number {
  return Math.round(settings.radius * 2 * settings.scale)
}

function forwardWebGLProbeLogs(window: BrowserWindow, page: string): void {
  window.webContents.on('console-message', (_event, _level, message) => {
    if (!message.includes('[webgl-probe]')) return
    console.info(`[renderer:${page}] ${message}`)
  })
}

app.on('before-quit', () => {
  if (magnifierWindow && !magnifierWindow.isDestroyed()) {
    magnifierWindow.setClosable(true)
  }
})
