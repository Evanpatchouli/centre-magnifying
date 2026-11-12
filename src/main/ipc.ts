import { desktopCapturer, ipcMain } from 'electron'
import { getSettings } from './store'
import type { CaptureSourceDTO, MagnifierSettings } from './types'
import { getSettingsWindow } from './windows'
import { setHotkey, startRecording, cancelRecording } from './global-hotkey'
import { getRenderModeFeatures } from './features'
import { applyMagnifierSettings } from './magnifier-controller'

/* ── IPC handlers ───────────────────────────────────────────────── */

export function registerIpcHandlers(): void {
  ipcMain.handle('window:control', (event, action: 'minimize' | 'toggle-maximize' | 'close') => {
    const win = getSettingsWindow()
    if (!win || event.sender !== win.webContents) return
    if (action === 'minimize') win.minimize()
    else if (action === 'toggle-maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (action === 'close') win.close()
  })
  ipcMain.handle('window:is-maximized', (event) => {
    const win = getSettingsWindow()
    return !!win && event.sender === win.webContents && win.isMaximized()
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('features:get-render-modes', () => getRenderModeFeatures())

  ipcMain.handle('settings:set', (_event, nextSettings: MagnifierSettings) => {
    const settings = applyMagnifierSettings(nextSettings)

    // Update global hotkey whenever settings change
    setHotkey(settings.showHotkey)

    return settings
  })

  ipcMain.handle('capture:get-sources', async (): Promise<CaptureSourceDTO[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: true,
    })

    return sources
      .filter((source) => source.name.trim().length > 0)
      .map((source) => ({
        id: source.id,
        name: source.name,
        appIcon: source.appIcon?.toDataURL() ?? null,
      }))
  })

  /* ── Hotkey recording ──────────────────────────────────── */

  ipcMain.handle('hotkey:start-recording', async (): Promise<string> => {
    return await startRecording()
  })

  ipcMain.handle('hotkey:cancel-recording', (): void => {
    cancelRecording()
  })
}
