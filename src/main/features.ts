import type { MagnifierSettings, RenderModeFeatures } from './types'

export function getRenderModeFeatures(): RenderModeFeatures {
  return {
    canvas2d: true,
    webgl: isEnabled(process.env.CENTRE_MAGNIFYING_ENABLE_WEBGL),
    nativeWgc: isEnabled(process.env.CENTRE_MAGNIFYING_ENABLE_NATIVE_WGC),
    webglProbeLogs: isEnabled(process.env.CENTRE_MAGNIFYING_WEBGL_PROBE_LOGS),
    nativeWgcProbeLogs: isEnabled(process.env.CENTRE_MAGNIFYING_NATIVE_WGC_PROBE_LOGS),
  }
}

export function isRenderModeEnabled(renderMode: MagnifierSettings['renderMode']): boolean {
  const features = getRenderModeFeatures()
  if (renderMode === 'canvas2d') return features.canvas2d
  if (renderMode === 'webgl') return features.webgl
  return features.nativeWgc
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase())
}
