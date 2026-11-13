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
  setNativeCaptureVisible,
  startNativeCapture,
  stopNativeCapture,
  updateNativeCapture,
} from './native-capture'
import { isMagnifierVisible, rememberMagnifierVisibility } from './magnifier-visibility'

const nativeStartError = 'Native WGC 启动失败。请确认目标窗口仍然打开，且 Windows 和显卡支持窗口捕获。'

function startNative(settings: MagnifierSettings, visible = isMagnifierVisible()): boolean {
  const match = settings.sourceId?.match(/^window:(\d+):/)
  if (!match) return false
  const hwnd = Number(match[1])
  return Number.isSafeInteger(hwnd) && hwnd > 0 && startNativeCapture({ hwnd, settings, visible })
}

function publishSettings(settings: MagnifierSettings): void {
  getMagnifierWindow()?.webContents.send('settings:changed', settings)
  getSettingsWindow()?.webContents.send('settings:changed', settings)
}

function useBrowserMagnifier(settings: MagnifierSettings): void {
  stopNativeCapture()
  const win = getMagnifierWindow() ?? createMagnifierWindow()
  updateMagnifierWindowBounds(settings)
  if (isMagnifierVisible()) win.showInactive()
  else win.hide()
}

/** Change visibility immediately without changing or saving the user's settings. */
export function setMagnifierVisibility(visible: boolean): boolean {
  const settings = getSettings()
  if (settings.renderMode === 'native-wgc') {
    if (isNativeCaptureRunning()) {
      if (!setNativeCaptureVisible(visible)) throw new Error(nativeStartError)
    } else if (visible) {
      // The target may have closed since capture was started. Retry using saved settings.
      if (!startNative(settings, true)) throw new Error(nativeStartError)
    }
  } else {
    const win = getMagnifierWindow() ?? (visible ? createMagnifierWindow() : null)
    if (visible) win?.showInactive()
    else win?.hide()
  }

  rememberMagnifierVisibility(visible)
  getSettingsWindow()?.webContents.send('magnifier:visibility-changed', visible)
  return visible
}

export function applyMagnifierSettings(requested: MagnifierSettings): MagnifierSettings {
  const previous = getSettings()
  const next = normalizeSettings(requested)

  if (next.renderMode === 'native-wgc') {
    const wasRunning = isNativeCaptureRunning()
    const sameSource = wasRunning && previous.renderMode === 'native-wgc' && previous.sourceId === next.sourceId
    const ok = sameSource ? updateNativeCapture(next) : startNative(next)
    if (!ok) {
      // A source change stops the old capture first. Restore it if the new one fails.
      if (wasRunning && !sameSource) {
        if (!startNative(previous)) {
          const fallback = saveSettings({ ...previous, renderMode: 'canvas2d' })
          useBrowserMagnifier(fallback)
          publishSettings(fallback)
        }
      }
      throw new Error(nativeStartError)
    }
    getMagnifierWindow()?.hide()
  } else {
    useBrowserMagnifier(next)
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
  useBrowserMagnifier(fallback)
  publishSettings(fallback)
  return nativeStartError
}
