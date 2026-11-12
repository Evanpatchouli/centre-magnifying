import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronVersion = require('electron/package.json').version
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
const addonDirectory = fileURLToPath(new URL('../native/capture-addon/', import.meta.url))
const result = spawnSync(process.execPath, [
  nodeGyp,
  'rebuild',
  `--target=${electronVersion}`,
  '--dist-url=https://electronjs.org/headers',
], { cwd: addonDirectory, stdio: 'inherit' })

if (result.error) console.error('Unable to start node-gyp:', result.error)
process.exitCode = result.status ?? 1
