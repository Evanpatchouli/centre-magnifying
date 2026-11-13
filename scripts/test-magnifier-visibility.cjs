const path = require('node:path')

if (!process.versions.electron) {
  if (process.platform !== 'win32') {
    console.error('Magnifier visibility integration tests require Windows.')
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
  const { app, BrowserWindow } = require('electron')
  const { uIOhook, UiohookKey } = require('uiohook-napi')
  const root = path.resolve(__dirname, '..')
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const switchSelector = '[role="switch"][aria-label="显示放大镜"]'

  // Isolate the test from the installed application's saved settings.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'centre-magnifying-test-')))
  app.getAppPath = () => root
  process.env.CENTRE_MAGNIFYING_ENABLE_WEBGL = 'true'

  async function waitFor(label, predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await predicate()) return
      await delay(100)
    }
    throw new Error(`Timed out: ${label}`)
  }

  async function run() {
    await import(pathToFileURL(path.join(root, 'out/main/index.js')).href)
    await app.whenReady()
    let settingsWindow
    let magnifier
    await waitFor('application windows', () => {
      const windows = BrowserWindow.getAllWindows()
      settingsWindow = windows.find((window) => window.webContents.getURL().includes('/settings/'))
      magnifier = windows.find((window) => window.webContents.getURL().includes('/magnifier/'))
      return settingsWindow && magnifier
    })
    const evaluate = (code) => settingsWindow.webContents.executeJavaScript(code)
    await waitFor('visibility switch', () => evaluate(`Boolean(document.querySelector(${JSON.stringify(switchSelector)}) && !document.querySelector(${JSON.stringify(switchSelector)}).disabled)`))
    const switchChecked = () => evaluate(`document.querySelector(${JSON.stringify(switchSelector)}).checked`)
    const clickSwitch = () => evaluate(`document.querySelector(${JSON.stringify(switchSelector)}).click()`)
    await waitFor('initial magnifier', () => magnifier.isVisible())
    assert.equal(await switchChecked(), true)
    console.log('PASS 设置窗口与初始显示状态')

    const target = new BrowserWindow({ width: 500, height: 350, title: 'Visibility test target' })
    await target.loadURL('data:text/html,<title>Visibility test target</title><body style="background:steelblue">Test target</body>')
    const hwnd = Number(target.getNativeWindowHandle().readBigUInt64LE())
    const source = { id: `window:${hwnd}:0`, name: 'Visibility test target' }
    console.log('PASS 捕获目标窗口')
    await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), sourceId: ${JSON.stringify(source.id)}, sourceName: ${JSON.stringify(source.name)}, showHotkey: 'F8' }))()`)

    await clickSwitch()
    await waitFor('switch hides browser magnifier', async () => !magnifier.isVisible() && !(await switchChecked()))
    await evaluate(`document.querySelectorAll('.nav-item')[1].click()`)
    await evaluate(`(() => { const input = document.querySelector('#radius'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '140'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await waitFor('edited settings', () => evaluate(`document.body.innerText.includes('有未应用的更改')`))
    await evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('应用设置')).click()`)
    await waitFor('settings saved', () => evaluate(`document.body.innerText.includes('设置已应用')`))
    assert.equal(magnifier.isVisible(), false, 'Applying settings must not show a hidden browser magnifier')
    assert.equal(await switchChecked(), false)
    console.log('PASS 设置开关与隐藏时应用设置')

    const pressHotkey = () => uIOhook.emit('keydown', { keycode: UiohookKey.F8, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false })
    pressHotkey()
    await waitFor('hotkey shows browser magnifier and updates switch', async () => magnifier.isVisible() && await switchChecked())
    pressHotkey()
    await waitFor('hotkey hides browser magnifier and updates switch', async () => !magnifier.isVisible() && !(await switchChecked()))
    console.log('PASS 快捷键与开关同步')

    const features = await evaluate('window.api.getRenderModeFeatures()')
    if (features.webgl) {
      await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), renderMode: 'webgl' }))()`)
      assert.equal(magnifier.isVisible(), false, 'Switching to WebGL must preserve hidden state')
    }
    if (features.nativeWgc) {
      const addon = require(path.join(root, 'native/capture-addon/build/Release/native_capture.node'))
      await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), renderMode: 'native-wgc' }))()`)
      assert.ok(addon.isRunning())
      assert.equal(addon.isVisible(), false, 'Native capture must start hidden')
      assert.equal(magnifier.isVisible(), false)
      await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), radius: 150 }))()`)
      assert.equal(addon.isVisible(), false, 'Updating native capture must preserve hidden state')
      await assert.rejects(evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), sourceId: 'window:1:0' }))()`))
      assert.equal(addon.isRunning(), true, 'The previous native source should be restored after a failed change')
      assert.equal(addon.isVisible(), false, 'Restoring the previous native source must preserve hidden state')
      const secondTarget = new BrowserWindow({ width: 400, height: 300, title: 'Second visibility target' })
      await secondTarget.loadURL('data:text/html,<title>Second visibility target</title><body>Second target</body>')
      const secondHwnd = Number(secondTarget.getNativeWindowHandle().readBigUInt64LE())
      await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), sourceId: 'window:${secondHwnd}:0', sourceName: 'Second visibility target' }))()`)
      assert.equal(addon.isVisible(), false, 'Changing the native source must preserve hidden state')
      await clickSwitch()
      await waitFor('switch shows native magnifier', async () => addon.isVisible() && await switchChecked())
      pressHotkey()
      await waitFor('hotkey hides native magnifier', async () => !addon.isVisible() && !(await switchChecked()))
      secondTarget.destroy()
      await waitFor('native capture stops after target closes', () => !addon.isRunning())
      await clickSwitch()
      await waitFor('failed visibility change is reported', () => evaluate(`document.body.innerText.includes('切换放大镜显示状态失败')`))
      assert.equal(await switchChecked(), false, 'A failed show request must leave the switch off')
      await evaluate(`(async () => window.api.setSettings({ ...await window.api.getSettings(), renderMode: 'canvas2d' }))()`)
      assert.equal(magnifier.isVisible(), false, 'Switching back to Canvas must preserve hidden state')
      assert.equal(addon.isRunning(), false)
      console.log('PASS Native WGC 隐藏启动、更新、失败恢复与模式切换')
    } else {
      console.log('SKIP Native WGC：当前环境不支持')
    }

    await clickSwitch()
    await waitFor('switch restores browser magnifier', async () => magnifier.isVisible() && await switchChecked())
    await delay(300)
    const screenshot = path.join(os.tmpdir(), 'centre-magnifying-visibility-test.png')
    fs.writeFileSync(screenshot, (await settingsWindow.webContents.capturePage()).toPNG())
    console.log(`PASS 设置界面截图：${screenshot}`)
    target.destroy()
  }

  run().then(() => app.quit()).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}
