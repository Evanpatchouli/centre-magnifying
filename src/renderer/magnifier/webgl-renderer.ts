import type { MagnifierSettings } from '../shared/types'

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`

const FRAGMENT_SHADER_SOURCE = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_video;
uniform vec2 u_texScale;
  uniform vec2 u_texOffset;

  void main() {
  // Flip Y – video frames are top-left origin, GL textures are bottom-left.
  vec2 flipped = vec2(v_texCoord.x, 1.0 - v_texCoord.y);
  vec2 videoUV = u_texOffset + flipped * u_texScale;
  vec4 color = texture2D(u_video, videoUV);
  gl_FragColor = vec4(color.rgb, 1.0);
}
`

/**
 * Quad covering clip space (-1..1, -1..1) as two triangles.
 * Each vertex: position (x, y), texCoord (s, t).
 */
const QUAD_VERTICES = new Float32Array([
  // first triangle
  -1, -1, 0, 0,
   1, -1, 1, 0,
  -1,  1, 0, 1,
  // second triangle
   1, -1, 1, 0,
  -1,  1, 0, 1,
   1,  1, 1, 1,
])

const VERTEX_STRIDE = 4 * Float32Array.BYTES_PER_ELEMENT

export interface WebGLRenderer {
  render(video: HTMLVideoElement, settings: MagnifierSettings): void
  dispose(): void
  isLost: boolean
}

export interface WebGLRendererOptions {
  probeLogs: boolean
}

interface GLResources {
  program: WebGLProgram
  vertexBuffer: WebGLBuffer
  videoTexture: WebGLTexture
  uTexScale: WebGLUniformLocation
  uTexOffset: WebGLUniformLocation
}

export function createWebGLRenderer(
  canvas: HTMLCanvasElement,
  options: WebGLRendererOptions = { probeLogs: false },
): WebGLRenderer | null {
  const gl = initContext(canvas)
  if (!gl) {
    logProbe(options, 'context-unavailable')
    return null
  }

  let resources = buildResources(gl)
  if (!resources) {
    logProbe(options, 'resources-unavailable')
    return null
  }

  const uploadCanvas = document.createElement('canvas')
  const uploadContext = uploadCanvas.getContext('2d')
  if (!uploadContext) {
    logProbe(options, 'upload-canvas-context-unavailable')
    return null
  }

  let disposed = false
  let renderCount = 0
  let lastProbeAt = 0

  logProbe(options, 'created', {
    renderer: gl.getParameter(gl.RENDERER),
    vendor: gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION),
  })

  function dispose(): void {
    if (disposed) return
    disposed = true

    const r = resources!
    gl!.deleteTexture(r.videoTexture)
    gl!.deleteProgram(r.program)
    gl!.deleteBuffer(r.vertexBuffer)
  }

  const renderer: WebGLRenderer = {
    isLost: false,

    render(video: HTMLVideoElement, settings: MagnifierSettings): void {
      if (disposed || renderer.isLost) return
      renderCount += 1

      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        logProbeThrottled(options, 'video-not-ready', lastProbeAt, (next) => { lastProbeAt = next }, {
          readyState: video.readyState,
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        })
        return
      }

      const outputSize = Math.round(settings.radius * 2 * settings.scale)
      const glCanvas = gl.canvas as HTMLCanvasElement

      if (glCanvas.width !== outputSize || glCanvas.height !== outputSize) {
        glCanvas.width = outputSize
        glCanvas.height = outputSize
        gl.viewport(0, 0, outputSize, outputSize)
      }

      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)

      // Compute UV scale/offset for source region (video centre crop)
      const sourceSize = settings.radius * 2
      const safe = Math.round(Math.min(sourceSize, video.videoWidth, video.videoHeight))
      const sx = Math.max(0, Math.round(video.videoWidth / 2 - safe / 2))
      const sy = Math.max(0, Math.round(video.videoHeight / 2 - safe / 2))

      if (uploadCanvas.width !== safe || uploadCanvas.height !== safe) {
        uploadCanvas.width = safe
        uploadCanvas.height = safe
      }
      uploadContext.clearRect(0, 0, safe, safe)
      uploadContext.drawImage(video, sx, sy, safe, safe, 0, 0, safe, safe)
      const shouldProbeFrame = shouldLogProbe(options, lastProbeAt)
      const centerPixel = shouldProbeFrame
        ? Array.from(uploadContext.getImageData(Math.floor(safe / 2), Math.floor(safe / 2), 1, 1).data)
        : null

      // Upload the Canvas-cropped frame instead of the video element directly.
      // Some desktop/game captures render correctly through Canvas 2D but fail
      // when the HTMLVideoElement is sampled as a WebGL texture.
      gl.bindTexture(gl.TEXTURE_2D, resources!.videoTexture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, uploadCanvas)
      const uploadError = gl.getError()

      // Set texture filtering from smooth setting
      const filter = settings.smoothing ? gl.LINEAR : gl.NEAREST
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)

      gl.uniform2f(resources!.uTexScale, 1, 1)
      gl.uniform2f(resources!.uTexOffset, 0, 0)

      // Draw full-screen quad – fragment shader handles circular mask
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      const drawError = gl.getError()

      if (shouldProbeFrame) {
        const framebufferPixel = new Uint8Array(4)
        gl.readPixels(Math.floor(outputSize / 2), Math.floor(outputSize / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, framebufferPixel)
        const readError = gl.getError()
        lastProbeAt = performance.now()

        logProbe(options, 'render-frame', {
          renderCount,
          readyState: video.readyState,
          currentTime: video.currentTime,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          outputSize,
          crop: { sx, sy, safe },
          centerPixel,
          framebufferPixel: Array.from(framebufferPixel),
          uploadError,
          drawError,
          readError,
        })
      }
    },

    dispose,
  }

  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault()
    renderer.isLost = true
  })

  canvas.addEventListener('webglcontextrestored', () => {
    const rebuilt = buildResources(gl)
    if (rebuilt) {
      resources = rebuilt
      renderer.isLost = false
    }
  })

  return renderer
}

function logProbe(options: WebGLRendererOptions, event: string, payload?: unknown): void {
  if (!options.probeLogs) return
  if (payload === undefined) {
    console.info(`[webgl-probe] ${event}`)
    return
  }
  console.info(`[webgl-probe] ${event} ${JSON.stringify(payload)}`)
}

function logProbeThrottled(
  options: WebGLRendererOptions,
  event: string,
  lastAt: number,
  setLastAt: (next: number) => void,
  payload: unknown,
): void {
  if (!options.probeLogs) return
  const now = performance.now()
  if (lastAt !== 0 && now - lastAt < 1000) return
  setLastAt(now)
  logProbe(options, event, payload)
}

function shouldLogProbe(options: WebGLRendererOptions, lastAt: number): boolean {
  if (!options.probeLogs) return false
  const now = performance.now()
  return lastAt === 0 || now - lastAt >= 1000
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                    */
/* ------------------------------------------------------------------ */

function initContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const attrs: WebGLContextAttributes = {
    alpha: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    antialias: false,
    depth: false,
    stencil: false,
  }

  // WebGL2 first, then WebGL1 fallback
  const gl = (canvas.getContext('webgl2', attrs)
    ?? canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null
  if (gl) {
    gl.disable(gl.BLEND)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }
  return gl
}

function buildResources(gl: WebGLRenderingContext): GLResources | null {
  const program = compileProgram(gl, VERTEX_SHADER_SOURCE, FRAGMENT_SHADER_SOURCE)
  if (!program) return null

  gl.useProgram(program)

  // Vertex buffer
  const vertexBuffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW)

  const posLoc = gl.getAttribLocation(program, 'a_position')
  const texLoc = gl.getAttribLocation(program, 'a_texCoord')

  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, VERTEX_STRIDE, 0)

  gl.enableVertexAttribArray(texLoc)
  gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, VERTEX_STRIDE, 2 * Float32Array.BYTES_PER_ELEMENT)

  // Video texture (unit 0)
  const videoTexture = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, videoTexture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const videoLoc = gl.getUniformLocation(program, 'u_video')
  if (videoLoc) gl.uniform1i(videoLoc, 0)

  // Cache uniform locations so render() doesn't call getUniformLocation per frame
  const uTexScale = gl.getUniformLocation(program, 'u_texScale')!
  const uTexOffset = gl.getUniformLocation(program, 'u_texOffset')!

  return { program, vertexBuffer, videoTexture, uTexScale, uTexOffset }
}

function compileProgram(
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (!vs || !fs) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return null
  }

  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)

  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('WebGL program link error:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  return program
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('WebGL shader compile error:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }

  return shader
}
