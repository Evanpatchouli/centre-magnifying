import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS } from '../shared/defaults'
import type { MagnifierSettings, RenderModeFeatures } from '../shared/types'
import { createWebGLRenderer, type WebGLRenderer } from './webgl-renderer'

const DEFAULT_RENDER_MODE_FEATURES: RenderModeFeatures = {
  canvas2d: true,
  webgl: false,
  nativeWgc: false,
  webglProbeLogs: false,
  nativeWgcProbeLogs: false,
}

export function MagnifierApp(): JSX.Element {
  const canvas2dRef = useRef<HTMLCanvasElement | null>(null)
  const webglCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const animationRef = useRef<number | null>(null)
  const videoFrameRef = useRef<number | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const settingsRef = useRef<MagnifierSettings>(DEFAULT_SETTINGS)
  const featuresRef = useRef<RenderModeFeatures>(DEFAULT_RENDER_MODE_FEATURES)
  const lastRenderedVideoTimeRef = useRef(-1)
  const webglRef = useRef<WebGLRenderer | null>(null)
  const renderLoopTokenRef = useRef(0)
  const captureTokenRef = useRef(0)
  /** Prev settings snapshot used to decide light vs full restart. */
  const prevSettingsRef = useRef<MagnifierSettings | null>(null)

  const [settings, setSettings] = useState<MagnifierSettings>(DEFAULT_SETTINGS)
  const [status, setStatus] = useState('请选择一个目标窗口')
  const [webglFallbackToCanvas, setWebglFallbackToCanvas] = useState(false)

  useEffect(() => {
    let disposed = false
    let settingsChanged = false

    Promise.all([window.api.getSettings(), window.api.getRenderModeFeatures()]).then(([loadedSettings, features]) => {
      if (disposed) return
      featuresRef.current = features
      logWebGLProbe('features-loaded', features)
      if (settingsChanged) return
      setSettings(loadedSettings)
      settingsRef.current = loadedSettings
      void fullRestart(loadedSettings)
    })

    const off = window.api.onSettingsChanged((nextSettings) => {
      settingsChanged = true
      setSettings(nextSettings)
      settingsRef.current = nextSettings
      void reconcileCapture(nextSettings)
    })

    return () => {
      disposed = true
      off()
      stopAll()
    }
  }, [])

  /* ── Capture lifecycle ──────────────────────────────────────── */

  /** Full restart: stop everything, create new video + stream, re-enter loop. */
  async function fullRestart(nextSettings: MagnifierSettings): Promise<void> {
    stopAll()
    const token = captureTokenRef.current
    resetRenderTracking()
    setWebglFallbackToCanvas(false)

    if (nextSettings.renderMode === 'native-wgc') {
      prevSettingsRef.current = nextSettings
      setStatus('')
      return
    }

    if (!nextSettings.sourceId) {
      setStatus('请选择一个目标窗口')
      return
    }

    try {
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.autoplay = true
      videoRef.current = video

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: nextSettings.sourceId,
            minFrameRate: nextSettings.fps,
            maxFrameRate: nextSettings.fps,
          },
        } as MediaTrackConstraints,
      })

      if (captureTokenRef.current !== token) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      video.srcObject = stream
      await video.play()
      if (captureTokenRef.current !== token) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      logWebGLProbe('capture-started', {
        sourceId: nextSettings.sourceId,
        renderMode: nextSettings.renderMode,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
        tracks: stream.getVideoTracks().map((track) => ({
          label: track.label,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
      })

      setStatus('')
      prevSettingsRef.current = nextSettings
      enterRenderLoop(nextSettings)
    } catch (error) {
      if (captureTokenRef.current !== token) return
      stopAll()
      console.error(error)
      setStatus('无法捕获目标窗口。请确认目标窗口仍然打开，并在设置中重新选择。')
    }
  }

  /**
   * Decide whether a settings change requires a full capture restart vs. a
   * lightweight renderer switch. Source and FPS changes restart browser capture;
   * switching to or from Native WGC also stops or starts the browser stream.
   */
  function reconcileCapture(nextSettings: MagnifierSettings): void {
    const prev = prevSettingsRef.current

    const needsFullRestart =
      !prev ||
      prev.sourceId !== nextSettings.sourceId ||
      prev.fps !== nextSettings.fps ||
      prev.renderMode === 'native-wgc' ||
      nextSettings.renderMode === 'native-wgc'

    prevSettingsRef.current = nextSettings

    if (needsFullRestart) {
      void fullRestart(nextSettings)
      return
    }

    // Light switch — capture pipeline is still alive, just swap renderer.
    if (!videoRef.current || !streamRef.current) {
      // Defensive: stream disappeared, do full restart anyway.
      void fullRestart(nextSettings)
      return
    }

    stopRenderLoop()
    if (nextSettings.renderMode !== 'webgl') {
      webglRef.current?.dispose()
      webglRef.current = null
    }
    resetRenderTracking()
    setWebglFallbackToCanvas(false)

    setStatus('')
    enterRenderLoop(nextSettings)
  }

  /* ── Teardown ───────────────────────────────────────────────── */

  function stopAll(): void {
    captureTokenRef.current += 1
    stopRenderLoop()
    webglRef.current?.dispose()
    webglRef.current = null

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    videoRef.current = null
  }

  function stopRenderLoop(): void {
    renderLoopTokenRef.current += 1
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
    if (videoFrameRef.current !== null && videoRef.current) {
      videoRef.current.cancelVideoFrameCallback?.(videoFrameRef.current)
      videoFrameRef.current = null
    }
  }

  function resetRenderTracking(): void {
    lastRenderedVideoTimeRef.current = -1
  }

  /* ── Render dispatch ────────────────────────────────────────── */

  function enterRenderLoop(settings: MagnifierSettings): void {
    logWebGLProbe('enter-render-loop', {
      renderMode: settings.renderMode,
      webglEnabled: featuresRef.current.webgl,
      webglProbeLogs: featuresRef.current.webglProbeLogs,
    })
    if (settings.renderMode === 'webgl') {
      startWebGLLoop()
    } else {
      startCanvasLoop()
    }
  }

  function startCanvasLoop(): void {
    startVideoLoop((newVideoFrame) => renderFrame(settingsRef.current, newVideoFrame))
  }

  /* ── WebGL path ─────────────────────────────────────────────── */

  function startWebGLLoop(): void {
    const video = videoRef.current
    const webglCanvas = webglCanvasRef.current
    if (!video || !webglCanvas) return

    if (!webglRef.current) {
      webglRef.current = createWebGLRenderer(webglCanvas, {
        probeLogs: featuresRef.current.webglProbeLogs,
      })
      if (!webglRef.current) {
        console.warn('WebGL 不可用，降级到 Canvas 2D')
        setWebglFallbackToCanvas(true)
        startCanvasLoop()
        return
      }
    }

    startVideoLoop(() => {
      if (!webglRef.current?.isLost) webglRef.current?.render(video, settingsRef.current)
    })
  }

  /** Draw each available video frame; capture itself is constrained to the selected fps. */
  function startVideoLoop(render: (newVideoFrame: boolean) => void): void {
    const video = videoRef.current
    if (!video) return
    const token = renderLoopTokenRef.current

    if (typeof video.requestVideoFrameCallback === 'function') {
      const onVideoFrame = (): void => {
        if (renderLoopTokenRef.current !== token) return
        render(true)
        videoFrameRef.current = video.requestVideoFrameCallback(onVideoFrame)
      }
      // Paint the current frame after a renderer or setting change even if the
      // capture source is static and does not deliver another frame immediately.
      animationRef.current = requestAnimationFrame(() => {
        if (renderLoopTokenRef.current !== token) return
        animationRef.current = null
        render(false)
        videoFrameRef.current = video.requestVideoFrameCallback(onVideoFrame)
      })
      return
    }

    // Older Chromium: retain fractional frame intervals instead of resetting the
    // deadline after every draw, which could halve the effective frame rate.
    let nextFrameAt = 0
    const onAnimationFrame = (now: number): void => {
      if (renderLoopTokenRef.current !== token) return
      const interval = 1000 / settingsRef.current.fps
      if (nextFrameAt === 0 || now + 0.25 >= nextFrameAt) {
        render(false)
        nextFrameAt = nextFrameAt === 0 || now - nextFrameAt > interval
          ? now + interval
          : nextFrameAt + interval
      }
      animationRef.current = requestAnimationFrame(onAnimationFrame)
    }
    animationRef.current = requestAnimationFrame(onAnimationFrame)
  }

  /* ── Canvas 2D path ─────────────────────────────────────────── */

  function renderFrame(currentSettings: MagnifierSettings, newVideoFrame: boolean): void {
    const canvas = canvas2dRef.current
    const video = videoRef.current
    if (!canvas || !video || video.videoWidth <= 0 || video.videoHeight <= 0) return

    const radius = currentSettings.radius
    const scale = currentSettings.scale
    const sourceSize = radius * 2
    const outputSize = Math.round(sourceSize * scale)
    const resized = resizeCanvasIfNeeded(canvas, outputSize)

    if (!newVideoFrame && !resized && video.currentTime === lastRenderedVideoTimeRef.current) return
    lastRenderedVideoTimeRef.current = video.currentTime

    const context = canvas.getContext('2d')
    if (!context) return

    const videoWidth = video.videoWidth
    const videoHeight = video.videoHeight
    const safeSourceSize = Math.min(sourceSize, videoWidth, videoHeight)
    const sx = Math.max(0, Math.round(videoWidth / 2 - safeSourceSize / 2))
    const sy = Math.max(0, Math.round(videoHeight / 2 - safeSourceSize / 2))

    context.clearRect(0, 0, outputSize, outputSize)
    context.imageSmoothingEnabled = currentSettings.smoothing
    context.imageSmoothingQuality = 'high'

    context.save()
    context.beginPath()
    context.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2)
    context.clip()

    context.drawImage(
      video,
      sx,
      sy,
      safeSourceSize,
      safeSourceSize,
      0,
      0,
      outputSize,
      outputSize,
    )

    context.restore()
  }

  function resizeCanvasIfNeeded(canvas: HTMLCanvasElement, outputSize: number): boolean {
    if (canvas.width === outputSize && canvas.height === outputSize) return false

    canvas.width = outputSize
    canvas.height = outputSize
    return true
  }

  /* ── Render ─────────────────────────────────────────────────── */

  const renderMode = webglFallbackToCanvas && settings.renderMode === 'webgl'
    ? 'canvas2d'
    : settings.renderMode

  return (
    <div className="magnifier-root">
      <canvas
        ref={canvas2dRef}
        className={`magnifier-canvas${renderMode === 'canvas2d' ? '' : ' magnifier-canvas--hidden'}`}
      />
      <canvas
        ref={webglCanvasRef}
        className={`magnifier-canvas${renderMode === 'webgl' ? '' : ' magnifier-canvas--hidden'}`}
      />
      {status ? <div className="placeholder">{status}</div> : null}
    </div>
  )
}

function logWebGLProbe(event: string, payload?: unknown): void {
  // MagnifierApp only logs high-level lifecycle. Per-frame details live in
  // webgl-renderer.ts and are also gated by this feature flag.
  void window.api.getRenderModeFeatures().then((features) => {
    if (!features.webglProbeLogs) return
    if (payload === undefined) {
      console.info(`[webgl-probe] ${event}`)
      return
    }
    console.info(`[webgl-probe] ${event} ${JSON.stringify(payload)}`)
  }).catch(() => {
    // Ignore logging failures; capture should keep running.
  })
}
