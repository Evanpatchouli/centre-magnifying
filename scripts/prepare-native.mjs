import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const buildScript = fileURLToPath(new URL('./build-addon.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' })
  if (result.error) console.error('Unable to build native capture:', result.error)
  process.exitCode = result.status ?? 1
}
