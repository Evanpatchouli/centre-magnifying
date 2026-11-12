import type { MagnifierSettings } from './types'
import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/* ── Addon interface ───────────────────────────────────────── */

interface NativeCaptureAddon {
  start(hwnd: number, params: NativeParams): boolean
  update(params: NativeParams): boolean
  stop(): boolean
  isRunning(): boolean
  isSupported(): boolean
  setVisible(visible: boolean): boolean
  isVisible(): boolean
}

interface NativeParams {
  radius: number
  scale: number
  fps: number
  smoothing: boolean
}

/* ── Lazy load ─────────────────────────────────────────────── */

let addon: NativeCaptureAddon | null = null
let loadAttempted = false

function loadAddon(): NativeCaptureAddon | null {
  if (addon || loadAttempted) return addon
  loadAttempted = true

  if (process.platform !== 'win32') {
    console.warn('[native-capture] 仅支持 Windows 平台')
    return null
  }

  try {
    const path = app.isPackaged
      ? join(process.resourcesPath, 'native', 'native_capture.node')
      : join(app.getAppPath(), 'native', 'capture-addon', 'build', 'Release', 'native_capture.node')
    addon = require(path) as NativeCaptureAddon
    return addon
  } catch (error) {
    const message = app.isPackaged ? '原生模块不可用。' : '原生模块未编译，请运行 npm run build:addon。'
    console.warn(`[native-capture] ${message}`, error)
    return null
  }
}

/* ── Public API ────────────────────────────────────────────── */

export interface NativeCaptureOptions {
  hwnd: number
  settings: MagnifierSettings
}

/**
 * Start native WGC capture + D3D11 rendering.
 * Returns `true` on success, `false` if the addon is unavailable or fails.
 */
export function startNativeCapture(opts: NativeCaptureOptions): boolean {
  const m = loadAddon()
  if (!m) return false

  try {
    if (m.isRunning()) m.stop()
    return m.start(opts.hwnd, toNativeParams(opts.settings))
  } catch (error) {
    console.error('[native-capture] 启动失败。', error)
    return false
  }
}

/** Update render parameters without restarting capture. */
export function updateNativeCapture(settings: MagnifierSettings): boolean {
  const m = loadAddon()
  if (!m || !m.isRunning()) return false

  try { return m.update(toNativeParams(settings)) }
  catch (error) {
    console.error('[native-capture] 更新失败。', error)
    return false
  }
}

/** Stop native capture and close the overlay window. */
export function stopNativeCapture(): boolean {
  return addon?.stop() ?? false
}

/** Query whether the native capture pipeline is currently active. */
export function isNativeCaptureRunning(): boolean {
  return addon?.isRunning() ?? false
}

export function isNativeCaptureAvailable(): boolean {
  const m = loadAddon()
  try { return m?.isSupported() ?? false }
  catch (error) {
    console.warn('[native-capture] 无法检查系统支持。', error)
    return false
  }
}

export function toggleNativeCaptureVisibility(): boolean {
  if (!addon?.isRunning()) return false
  addon.setVisible(!addon.isVisible())
  return true
}

export function isNativeCaptureVisible(): boolean {
  return Boolean(addon?.isRunning() && addon.isVisible())
}

export function setNativeCaptureVisible(visible: boolean): void {
  if (addon?.isRunning()) addon.setVisible(visible)
}

function toNativeParams(settings: MagnifierSettings): NativeParams {
  return {
    radius: settings.radius,
    scale: settings.scale,
    fps: settings.fps,
    smoothing: settings.smoothing,
  }
}
