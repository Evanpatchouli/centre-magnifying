import type { MagnifierSettings } from './types'

/* ── Addon interface ───────────────────────────────────────── */

interface NativeCaptureAddon {
  start(hwnd: number, params: NativeParams): boolean
  update(params: Partial<NativeParams>): boolean
  stop(): boolean
  isRunning(): boolean
}

interface NativeParams {
  radius: number
  scale: number
  smoothing: boolean
}

/* ── Lazy load ─────────────────────────────────────────────── */

let addon: NativeCaptureAddon | null = null

function loadAddon(): NativeCaptureAddon | null {
  if (addon) return addon

  if (process.platform !== 'win32') {
    console.warn('[native-capture] 仅支持 Windows 平台')
    return null
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    addon = require('../../native/capture-addon/build/Release/native_capture.node')
    return addon
  } catch (error) {
    console.warn('[native-capture] 原生模块未编译，请运行 npm run build:addon。', error)
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

  if (m.isRunning()) {
    m.stop()
  }

  return m.start(opts.hwnd, {
    radius: opts.settings.radius,
    scale: opts.settings.scale,
    smoothing: opts.settings.smoothing,
  })
}

/** Update render parameters without restarting capture. */
export function updateNativeCapture(settings: MagnifierSettings): boolean {
  const m = loadAddon()
  if (!m || !m.isRunning()) return false

  return m.update({
    radius: settings.radius,
    scale: settings.scale,
    smoothing: settings.smoothing,
  })
}

/** Stop native capture and close the overlay window. */
export function stopNativeCapture(): boolean {
  const m = loadAddon()
  if (!m) return false

  if (!m.isRunning()) return false
  return m.stop()
}

/** Query whether the native capture pipeline is currently active. */
export function isNativeCaptureRunning(): boolean {
  const m = loadAddon()
  if (!m) return false
  return m.isRunning()
}
