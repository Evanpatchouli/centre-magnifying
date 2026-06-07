import { desktopCapturer, ipcMain } from 'electron'
import { getSettings, saveSettings } from './store'
import type { CaptureSourceDTO, MagnifierSettings } from './types'
import {
  createMagnifierWindow,
  getMagnifierWindow,
  getSettingsWindow,
  updateMagnifierWindowBounds,
} from './windows'
import { startNativeCapture, stopNativeCapture } from './native-capture'
import { setHotkey, startRecording, cancelRecording } from './global-hotkey'
import { getRenderModeFeatures } from './features'

/**
 * Electron desktopCapturer source IDs are in the format `window:XXXX:0`
 * where XXXX is the decimal HWND value of the captured window.
 */
function extractHwndFromSourceId(sourceId: string): number | null {
  const match = sourceId.match(/^window:(\d+):/)
  return match ? parseInt(match[1], 10) : null
}

/* ── IPC handlers ───────────────────────────────────────────────── */

export function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('features:get-render-modes', () => getRenderModeFeatures())

  ipcMain.handle('settings:set', (_event, nextSettings: MagnifierSettings) => {
    const settings = saveSettings(nextSettings)

    if (settings.renderMode === 'native-wgc' && settings.sourceId) {
      // ── Native WGC mode ──────────────────────────────────
      const hwnd = extractHwndFromSourceId(settings.sourceId)
      if (hwnd) {
        stopNativeCapture()
        const ok = startNativeCapture({ hwnd, settings })
        if (ok) {
          getMagnifierWindow()?.hide()
        }
      }
      getSettingsWindow()?.webContents.send('settings:changed', settings)
    } else {
      // ── Canvas 2D or WebGL mode ──────────────────────────
      stopNativeCapture()

      const mw = getMagnifierWindow()
      if (mw && !mw.isDestroyed()) {
        updateMagnifierWindowBounds(settings)
        mw.showInactive()
      } else {
        createMagnifierWindow()
      }

      getMagnifierWindow()?.webContents.send('settings:changed', settings)
      getSettingsWindow()?.webContents.send('settings:changed', settings)
    }

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
