import { desktopCapturer, ipcMain } from 'electron'
import { getSettings } from './store'
import type { CaptureSourceDTO, MagnifierSettings } from './types'
import { setHotkey, startRecording, cancelRecording } from './global-hotkey'
import { getRenderModeFeatures } from './features'
import { applyMagnifierSettings, setMagnifierVisibility } from './magnifier-controller'
import { isMagnifierVisible } from './magnifier-visibility'
import { getSettingsWindow } from './windows'

/* ── IPC handlers ───────────────────────────────────────────────── */

export function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('features:get-render-modes', () => getRenderModeFeatures())
  ipcMain.handle('magnifier:get-visibility', () => isMagnifierVisible())
  ipcMain.handle('magnifier:set-visibility', (event, visible: unknown) => {
    if (event.sender !== getSettingsWindow()?.webContents || typeof visible !== 'boolean') {
      throw new Error('Invalid magnifier visibility request')
    }
    return setMagnifierVisibility(visible)
  })

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
