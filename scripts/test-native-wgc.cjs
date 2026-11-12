const path = require('node:path')

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.error('Native WGC integration tests require Windows.')
    process.exit(1)
  }
  const { spawn } = require('node:child_process')
  const child = spawn(require('electron'), [__filename], { stdio: 'inherit' })
  child.on('error', (error) => { console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} else {
  const assert = require('node:assert/strict')
  const { app, BrowserWindow, desktopCapturer, screen } = require('electron')
  const addon = require('../native/capture-addon/build/Release/native_capture.node')
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  app.setPath('userData', path.join(__dirname, '../native/capture-addon/build/test-profile'))
  app.on('window-all-closed', () => {})

  async function sampleOverlay(offset) {
    const display = screen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    })
    const source = sources.find((item) => item.display_id === String(display.id)) || sources[0]
    assert.ok(source, 'Primary display was not available for verification')
    const image = source.thumbnail
    const { width, height } = image.getSize()
    const pixels = image.toBitmap()
    const sample = (y) => {
      const index = (Math.round(y) * width + Math.round(width / 2)) * 4
      return { r: pixels[index + 2], g: pixels[index + 1], b: pixels[index] }
    }
    return [sample(height / 2 - offset * display.scaleFactor), sample(height / 2 + offset * display.scaleFactor)]
  }

  async function expectColors(label, offset, expected) {
    let actual
    for (let attempt = 0; attempt < 15; attempt++) {
      await delay(350)
      actual = await sampleOverlay(offset)
      if (actual.every((color, i) => ['r', 'g', 'b'].every((channel) =>
        Math.abs(color[channel] - expected[i][channel]) < 30))) {
        console.log(`PASS ${label}`)
        return
      }
    }
    assert.fail(`${label}: unexpected overlay colors ${JSON.stringify(actual)}`)
  }

  async function run() {
    assert.ok(addon.isSupported(), 'Windows Graphics Capture is not supported')
    const bounds = screen.getPrimaryDisplay().bounds
    const width = Math.min(600, Math.floor(bounds.width * 0.4))
    const height = Math.min(400, Math.floor(bounds.height * 0.4))
    const target = new BrowserWindow({
      frame: false, show: false, x: bounds.x, y: bounds.y, width, height,
      webPreferences: { backgroundThrottling: false },
    })
    await target.loadURL('data:text/html,<body style="margin:0"><div id="top" style="height:50vh;background:red"></div><div id="bottom" style="height:50vh;background:blue"></div></body>')
    target.show()
    await delay(1000)
    const hwnd = Number(target.getNativeWindowHandle().readBigUInt64LE())
    assert.ok(addon.start(hwnd, { radius: 80, scale: 2, fps: 60, smoothing: false }))
    await expectColors('完整画面和上下方向', 60, [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }])

    assert.ok(addon.update({ radius: 100, scale: 2.4, fps: 30, smoothing: false }))
    await expectColors('修改放大镜尺寸', 180, [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }])

    const cover = new BrowserWindow({ frame: false, show: false, ...target.getBounds() })
    await cover.loadURL('data:text/html,<body style="background:fuchsia"></body>')
    cover.show()
    await target.webContents.executeJavaScript("document.getElementById('top').style.background = 'lime'; document.getElementById('bottom').style.background = 'yellow'")
    await expectColors('目标被遮挡时仍捕获目标窗口', 60, [{ r: 0, g: 255, b: 0 }, { r: 255, g: 255, b: 0 }])

    target.setSize(width + 40, height + 40)
    await target.webContents.executeJavaScript("document.getElementById('top').style.background = 'red'; document.getElementById('bottom').style.background = 'blue'")
    await expectColors('目标窗口调整大小后继续捕获', 60, [{ r: 255, g: 0, b: 0 }, { r: 0, g: 0, b: 255 }])
    cover.destroy()

    assert.ok(addon.setVisible(false))
    assert.equal(addon.isVisible(), false)
    assert.ok(addon.setVisible(true))
    assert.equal(addon.isVisible(), true)
    console.log('PASS 显示与隐藏')

    await target.webContents.executeJavaScript(`
      const marker = document.createElement('div');
      Object.assign(marker.style, { position: 'fixed', top: 0, left: 0, width: '4px', height: '4px' });
      document.body.appendChild(marker);
      setInterval(() => { marker.style.background = marker.style.background === 'black' ? 'white' : 'black' }, 16);
    `)
    for (let i = 0; i < 5; i++) {
      assert.ok(addon.stop())
      assert.ok(addon.start(hwnd, { radius: 80, scale: 2, fps: 60, smoothing: true }))
      await delay(150)
    }
    target.destroy()
    await delay(300)
    assert.equal(addon.isRunning(), false, 'Capture should stop when the target closes')
    assert.ok(addon.stop())
    assert.equal(addon.start(0, { radius: 80, scale: 2, fps: 60, smoothing: true }), false)
    addon.stop()
    console.log('PASS 重复启动、停止和关闭目标窗口')
  }

  app.whenReady().then(run).then(() => app.quit()).catch((error) => {
    console.error(error)
    addon.stop()
    app.exit(1)
  })
}
