const path = require('node:path')

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.error('Edge-softening integration tests require Windows.')
    process.exit(1)
  }
  const { spawn } = require('node:child_process')
  const child = spawn(require('electron'), [__filename], { stdio: 'inherit' })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} else {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const os = require('node:os')
  const { pathToFileURL } = require('node:url')
  const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
  const root = path.resolve(__dirname, '..')
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'centre-magnifying-edge-')))
  app.getAppPath = () => root
  process.env.CENTRE_MAGNIFYING_ENABLE_WEBGL = 'true'

  async function waitFor(label, predicate) {
    let last
    for (let attempt = 0; attempt < 80; attempt++) {
      last = await predicate()
      if (last) return last
      await delay(150)
    }
    throw new Error(`Timed out: ${label}`)
  }

  async function screenshot() {
    const display = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    })
    return (sources.find((source) => source.display_id === String(display.id)) || sources[0]).thumbnail
  }

  function sample(image, offset, xOffset = 0) {
    const { width, height } = image.getSize()
    const pixels = image.toBitmap()
    const display = screen.getPrimaryDisplay()
    const index = (Math.round(height / 2 + offset * display.scaleFactor) * width + Math.round(width / 2 + xOffset * display.scaleFactor)) * 4
    return { r: pixels[index + 2], g: pixels[index + 1], b: pixels[index] }
  }

  async function expectColors(label, expected) {
    let colors
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(150)
      const image = await screenshot()
      colors = expected.map(([offset]) => sample(image, offset))
      if (expected.every(([, target], index) => ['r', 'g', 'b'].every((channel) =>
        Math.abs(colors[index][channel] - target[channel]) < 35))) {
        console.log(`PASS ${label}`)
        return image
      }
    }
    assert.fail(`${label}: unexpected desktop colors ${JSON.stringify(colors)}`)
  }

  async function run() {
    await import(pathToFileURL(path.join(root, 'out/main/index.js')).href)
    await app.whenReady()
    let settingsWindow
    let magnifier
    await waitFor('settings window', () => {
      settingsWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/settings/'))
      magnifier = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/magnifier/'))
      return settingsWindow && magnifier
    })
    const evaluate = (code) => settingsWindow.webContents.executeJavaScript(code)
    settingsWindow.webContents.setBackgroundThrottling(false)
    await waitFor('settings controls', () => evaluate("Boolean(document.querySelector('.nav-item'))"))

    const bounds = screen.getPrimaryDisplay().bounds
    const target = new BrowserWindow({ frame: false, show: false, x: bounds.x, y: bounds.y, width: 600, height: 400 })
    await target.loadURL('data:text/html,<body style="margin:0"><div style="height:50vh;background:red"></div><div style="height:50vh;background:blue"></div></body>')
    target.show()
    const hwnd = Number(target.getNativeWindowHandle().readBigUInt64LE())
    const backdrop = new BrowserWindow({ frame: false, show: false, ...bounds, skipTaskbar: true })
    await backdrop.loadURL('data:text/html,<body style="margin:0;background:lime"></body>')
    backdrop.setAlwaysOnTop(true, 'floating')
    backdrop.show()

    await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), sourceId: 'window:${hwnd}:0', sourceName: 'Edge test target', radius: 80, scale: 2, fps: 60, smoothing: false, renderMode: 'canvas2d' }))()`)
    magnifier.moveTop()
    await evaluate("document.querySelectorAll('.nav-item')[1].click()")
    const toggle = '[role="switch"][aria-label="边缘柔化"]'
    await waitFor('renamed edge-softening control', () => evaluate(`Boolean(document.querySelector(${JSON.stringify(toggle)}))`))
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(toggle)}).checked`), false)

    const hard = [[-60, { r: 255, g: 0, b: 0 }], [-144, { r: 255, g: 0, b: 0 }], [-170, { r: 0, g: 255, b: 0 }]]
    const soft = [[-60, { r: 255, g: 0, b: 0 }], [-144, { r: 128, g: 128, b: 0 }], [-170, { r: 0, g: 255, b: 0 }]]
    await expectColors('Canvas 2D 关闭柔化', hard)
    await evaluate(`document.querySelector(${JSON.stringify(toggle)}).click()`)
    await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('应用设置')).click()")
    await waitFor('edge-softening setting saved', () => evaluate('(async () => (await window.api.getSettings()).smoothing)()'))
    magnifier.moveTop()
    const evidence = await expectColors('Canvas 2D 开启柔化', soft)
    const evidencePath = path.join(os.tmpdir(), 'centre-magnifying-edge-softening-crop.png')
    const evidenceSize = evidence.getSize()
    const cropSize = Math.round(400 * screen.getPrimaryDisplay().scaleFactor)
    const croppedEvidence = evidence.crop({
      x: Math.round((evidenceSize.width - cropSize) / 2),
      y: Math.round((evidenceSize.height - cropSize) / 2),
      width: cropSize,
      height: cropSize,
    })
    fs.writeFileSync(evidencePath, croppedEvidence.toPNG())
    console.log(`PASS 实际桌面截图：${evidencePath}`)
    await magnifier.webContents.executeJavaScript(`(() => {
      const style = document.createElement('style')
      style.id = 'disable-test-blur'
      style.textContent = '.magnifier-root--soft-edge::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'
      document.head.appendChild(style)
    })()`)
    await delay(350)
    const noBlur = await screenshot()
    await magnifier.webContents.executeJavaScript("document.getElementById('disable-test-blur').remove()")
    const blurredEdge = sample(evidence, 2, 140)
    const sharpEdge = sample(noBlur, 2, 140)
    assert.ok(blurredEdge.r > sharpEdge.r + 4, `The edge should blur captured detail: ${JSON.stringify({ blurredEdge, sharpEdge })}`)
    const center = sample(evidence, 2)
    const centerWithoutBlur = sample(noBlur, 2)
    assert.ok(['r', 'g', 'b'].every((channel) => Math.abs(center[channel] - centerWithoutBlur[channel]) < 5), 'The center must remain clear')
    console.log('PASS Canvas 2D 边缘细节渐进虚化')

    backdrop.hide()
    magnifier.hide()
    settingsWindow.show()
    settingsWindow.focus()
    await waitFor('settings panel animation', () => evaluate("getComputedStyle(document.querySelector('.view')).opacity === '1'"))
    await delay(500)
    fs.writeFileSync(path.join(os.tmpdir(), 'centre-magnifying-edge-settings.png'), (await settingsWindow.webContents.capturePage()).toPNG())
    backdrop.showInactive()
    magnifier.showInactive()
    magnifier.moveTop()

    await evaluate("(async () => window.api.setSettings({ ...await window.api.getSettings(), renderMode: 'webgl' }))()")
    await waitFor('WebGL canvas is active', () => magnifier.webContents.executeJavaScript("!document.querySelectorAll('canvas')[1].classList.contains('magnifier-canvas--hidden')"))
    magnifier.moveTop()
    await expectColors('WebGL 开启柔化', soft)
    assert.equal(await magnifier.webContents.executeJavaScript("document.querySelectorAll('canvas')[1].classList.contains('magnifier-canvas--hidden')"), false, 'WebGL must remain active')
    await evaluate("(async () => window.api.setSettings({ ...await window.api.getSettings(), smoothing: false }))()")
    await expectColors('WebGL 关闭柔化', hard)

    await evaluate("(async () => window.api.setSettings({ ...await window.api.getSettings(), sourceId: null, sourceName: null }))()")
    await waitFor('capture stopped', () => magnifier.webContents.executeJavaScript("Boolean(document.querySelector('.placeholder'))"))
    backdrop.destroy()
    target.destroy()
  }

  run().then(() => app.quit()).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}
