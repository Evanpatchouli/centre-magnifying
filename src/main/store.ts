import Store from 'electron-store'
import { DEFAULT_SETTINGS, type MagnifierSettings } from './types'
import { isRenderModeEnabled } from './features'

const ALLOWED_FPS_VALUES = [30, 60, 90, 120] as const
type AllowedFps = (typeof ALLOWED_FPS_VALUES)[number]

export const store = new Store<{ settings: MagnifierSettings }>({
  name: 'centre-magnifying',
  defaults: {
    settings: DEFAULT_SETTINGS,
  },
})

export function getSettings(): MagnifierSettings {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...store.get('settings') })
}

export function saveSettings(settings: MagnifierSettings): MagnifierSettings {
  const normalized = normalizeSettings(settings)
  store.set('settings', normalized)
  return normalized
}

function normalizeSettings(settings: MagnifierSettings): MagnifierSettings {
  const normalized: MagnifierSettings = {
    sourceId: settings.sourceId ?? null,
    sourceName: settings.sourceName ?? null,
    radius: clampNumber(settings.radius, 40, 600, DEFAULT_SETTINGS.radius),
    scale: clampNumber(settings.scale, 1, 8, DEFAULT_SETTINGS.scale),
    fps: normalizeFps(settings.fps),
    smoothing: Boolean(settings.smoothing),
    renderMode: normalizeRenderMode(settings.renderMode),
    showHotkey: typeof settings.showHotkey === 'string' ? settings.showHotkey : null,
  }

  return normalized
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function normalizeFps(value: number): AllowedFps {
  return ALLOWED_FPS_VALUES.includes(value as AllowedFps) ? (value as AllowedFps) : 60
}

function normalizeRenderMode(value: string): MagnifierSettings['renderMode'] {
  if (!['canvas2d', 'webgl', 'native-wgc'].includes(value)) return 'canvas2d'
  const renderMode = value as MagnifierSettings['renderMode']
  return isRenderModeEnabled(renderMode) ? renderMode : 'canvas2d'
}
