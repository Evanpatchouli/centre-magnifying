import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createTray } from './tray'
import { createMagnifierWindow, showSettingsWindow } from './windows'
import { registerIpcHandlers } from './ipc'
import { getSettings } from './store'
import { init as initHotkey, shutdown as shutdownHotkey, setHotkey } from './global-hotkey'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.centre.magnifying')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  initHotkey()
  setHotkey(getSettings().showHotkey)

  createTray()
  createMagnifierWindow()

  if (shouldOpenSettingsOnStart()) {
    showSettingsWindow()
  }

  app.on('activate', () => {
    createMagnifierWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep tray application alive. Use tray menu -> 退出 to quit.
})

app.on('will-quit', () => {
  shutdownHotkey()
})

function shouldOpenSettingsOnStart(): boolean {
  return process.argv.includes('--settings') || !getSettings().sourceId || !app.isPackaged
}
