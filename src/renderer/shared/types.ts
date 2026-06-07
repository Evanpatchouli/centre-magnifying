export type CaptureSourceDTO = {
  id: string
  name: string
  appIcon: string | null
}

export type MagnifierSettings = {
  sourceId: string | null
  sourceName: string | null
  radius: number
  scale: number
  fps: 30 | 60 | 90 | 120 | (number & {})
  smoothing: boolean
  renderMode: 'canvas2d' | 'webgl' | 'native-wgc'
  showHotkey: string | null
}

export type RenderModeFeatures = {
  canvas2d: boolean
  webgl: boolean
  nativeWgc: boolean
  webglProbeLogs: boolean
  nativeWgcProbeLogs: boolean
}
