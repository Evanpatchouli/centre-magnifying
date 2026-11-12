import { getSettings, normalizeSettings, saveSettings } from './store'
import type { MagnifierSettings } from './types'
import {
  createMagnifierWindow,
  getMagnifierWindow,
  getSettingsWindow,
  updateMagnifierWindowBounds,
} from './windows'
import {
  isNativeCaptureRunning,
  isNativeCaptureVisible,
  setNativeCaptureVisible,
  startNativeCapture,
  stopNativeCapture,
  updateNativeCapture,
} from './native-capture'

const nativeStartError = 'Native WGC 启动失败。请确认目标窗口仍然打开，且 Windows 和显卡支持窗口捕获。'

function startNative(settings: MagnifierSettings): boolean {
  const match = settings.sourceId?.match(/^window:(\d+):/)
  if (!match) return false
  const hwnd = Number(match[1])
  return Number.isSafeInteger(hwnd) && hwnd > 0 && startNativeCapture({ hwnd, settings })
}

function publishSettings(settings: MagnifierSettings): void {
  getMagnifierWindow()?.webContents.send('settings:changed', settings)
  getSettingsWindow()?.webContents.send('settings:changed', settings)
}

function showBrowserMagnifier(settings: MagnifierSettings): void {
  stopNativeCapture()
  const win = getMagnifierWindow() ?? createMagnifierWindow()
  updateMagnifierWindowBounds(settings)
  win.showInactive()
}

export function applyMagnifierSettings(requested: MagnifierSettings): MagnifierSettings {
  const previous = getSettings()
  const next = normalizeSettings(requested)

  if (next.renderMode === 'native-wgc') {
    const wasRunning = isNativeCaptureRunning()
    const wasVisible = isNativeCaptureVisible()
    const sameSource = wasRunning && previous.renderMode === 'native-wgc' && previous.sourceId === next.sourceId
    const ok = sameSource ? updateNativeCapture(next) : startNative(next)
    if (!ok) {
      // A source change stops the old capture first. Restore it if the new one fails.
      if (wasRunning && !sameSource) {
        if (startNative(previous)) {
          setNativeCaptureVisible(wasVisible)
        } else {
          const fallback = saveSettings({ ...previous, renderMode: 'canvas2d' })
          showBrowserMagnifier(fallback)
          publishSettings(fallback)
        }
      }
      throw new Error(nativeStartError)
    }
    if (wasRunning && !sameSource) setNativeCaptureVisible(wasVisible)
    getMagnifierWindow()?.hide()
  } else {
    showBrowserMagnifier(next)
  }

  const saved = saveSettings(next)
  publishSettings(saved)
  return saved
}

/** Restore a persisted native capture after the Electron windows are created. */
export function restoreNativeCapture(): string | null {
  const settings = getSettings()
  if (settings.renderMode !== 'native-wgc') return null
  if (startNative(settings)) {
    getMagnifierWindow()?.hide()
    return null
  }

  const fallback = saveSettings({ ...settings, renderMode: 'canvas2d' })
  showBrowserMagnifier(fallback)
  publishSettings(fallback)
  return nativeStartError
}
