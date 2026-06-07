import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'

const env = loadEnv(getMode())
const shouldFilterWgcLogs = isEnabled(env.CENTRE_MAGNIFYING_FILTER_WGC_LOGS)
const args = [resolve('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', ...process.argv.slice(2)]
const command = process.execPath
const child = spawn(command, args, {
  stdio: ['inherit', 'pipe', 'pipe'],
  env,
})

pipeFiltered(child.stdout, process.stdout)
pipeFiltered(child.stderr, process.stderr)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

function pipeFiltered(source, target) {
  let pending = ''

  source.setEncoding('utf8')
  source.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ''

    for (const line of lines) {
      writeLineIfUseful(line, target)
    }
  })

  source.on('end', () => {
    if (pending) {
      writeLineIfUseful(pending, target)
    }
  })
}

function writeLineIfUseful(line, target) {
  if (shouldFilterWgcLogs && isNoisyWgcFrameReuseLog(line)) return

  target.write(`${line}\n`)
}

function isNoisyWgcFrameReuseLog(line) {
  return line.includes('wgc_capture_session.cc') && line.includes('ProcessFrame failed, using existing frame')
}

function loadEnv(mode) {
  const env = { ...process.env }

  for (const file of ['.env', `.env.${mode}`]) {
    const path = resolve(file)
    if (existsSync(path)) {
      loadDotenv({ path, processEnv: env, override: true, quiet: true })
    }
  }

  return env
}

function getMode() {
  const modeIndex = process.argv.indexOf('--mode')
  if (modeIndex >= 0 && process.argv[modeIndex + 1]) {
    return process.argv[modeIndex + 1]
  }

  const inlineMode = process.argv.find((arg) => arg.startsWith('--mode='))
  if (inlineMode) {
    return inlineMode.slice('--mode='.length)
  }

  return process.env.NODE_ENV ?? 'development'
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase())
}
