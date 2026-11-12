import { app, dialog } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { createTray } from './tray'
import { createMagnifierWindow, showSettingsWindow } from './windows'
import { registerIpcHandlers } from './ipc'
import { getSettings } from './store'
import { init as initHotkey, shutdown as shutdownHotkey, setHotkey } from './global-hotkey'
import { restoreNativeCapture } from './magnifier-controller'
import { stopNativeCapture } from './native-capture'

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
  const captureError = restoreNativeCapture()

  if (captureError || shouldOpenSettingsOnStart()) {
    showSettingsWindow()
  }
  if (captureError) {
    void dialog.showMessageBox({ type: 'warning', message: captureError, detail: '已切换到 Canvas 2D，请在设置中重新选择窗口。' })
  }

  app.on('activate', () => {
    createMagnifierWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep tray application alive. Use tray menu -> 退出 to quit.
})

app.on('will-quit', () => {
  stopNativeCapture()
  shutdownHotkey()
})

function shouldOpenSettingsOnStart(): boolean {
  return process.argv.includes('--settings') || !getSettings().sourceId || !app.isPackaged
}
