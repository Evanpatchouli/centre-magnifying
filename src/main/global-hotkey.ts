import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi'
import { getMagnifierWindow, createMagnifierWindow } from './windows'

/* ── Build reverse keycode → name map once ─────────────────────── */

const KEYCODE_TO_NAME: Record<number, string> = {}
for (const [name, code] of Object.entries(UiohookKey)) {
  if (Number.isNaN(Number(name))) {
    KEYCODE_TO_NAME[code as number] = name
  }
}

function keycodeToName(keycode: number): string {
  return KEYCODE_TO_NAME[keycode] ?? `Key${keycode}`
}

function formatAccelerator(
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean,
  key: string,
): string {
  const parts: string[] = []
  if (ctrl || meta) parts.push('CommandOrControl')
  if (shift) parts.push('Shift')
  if (alt) parts.push('Alt')
  parts.push(key)
  return parts.join('+')
}

function isModifierKeycode(keycode: number): boolean {
  return (
    keycode === UiohookKey.Ctrl ||
    keycode === UiohookKey.CtrlRight ||
    keycode === UiohookKey.Shift ||
    keycode === UiohookKey.ShiftRight ||
    keycode === UiohookKey.Alt ||
    keycode === UiohookKey.AltRight ||
    keycode === UiohookKey.Meta ||
    keycode === UiohookKey.MetaRight
  )
}

/* ── State ─────────────────────────────────────────────────────── */

let activeHotkey: string | null = null

let recordingResolve: ((acc: string) => void) | null = null
let recordingTimer: ReturnType<typeof setTimeout> | null = null

/* ── Lifecycle ─────────────────────────────────────────────────── */

export function init(): void {
  uIOhook.on('keydown', handleKeyDown)
  uIOhook.on('mousedown', handleMouseDown)
  uIOhook.start()
}

export function shutdown(): void {
  uIOhook.stop()
  uIOhook.removeAllListeners()
}

/* ── Hotkey config ─────────────────────────────────────────────── */

export function setHotkey(accelerator: string | null): void {
  activeHotkey = accelerator
}

/* ── Recording ─────────────────────────────────────────────────── */

/**
 * Start recording the next user input (key or mouse) globally.
 * Returns the accelerator string when captured, or empty string on timeout.
 */
export function startRecording(): Promise<string> {
  cancelRecording()
  return new Promise((resolve) => {
    recordingResolve = resolve
    recordingTimer = setTimeout(() => {
      recordingResolve = null
      resolve('')
    }, 15_000)
  })
}

export function cancelRecording(): void {
  if (recordingTimer !== null) {
    clearTimeout(recordingTimer)
    recordingTimer = null
  }
  recordingResolve = null
}

/* ── Event handlers ────────────────────────────────────────────── */

function isMouseButton(button: unknown): button is number {
  return typeof button === 'number'
}

function isModifierModifier(e: UiohookKeyboardEvent): boolean {
  return isModifierKeycode(e.keycode) && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey
}

function triggerToggle(): void {
  toggleMagnifierVisibility()
}

/* ── Keyboard handler ──────────────────────────────────────────── */

function handleKeyDown(e: UiohookKeyboardEvent): void {
  // Ignore bare modifier keys (no other keys held)
  if (isModifierKeycode(e.keycode) && e.ctrlKey && e.shiftKey && e.altKey && e.metaKey) {
    // all false + a modifier keycode = bare modifier press
    if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return
  }
  // If only a modifier is pressed alone, skip
  if (isModifierModifier(e)) return

  const key = keycodeToName(e.keycode)
  const acc = formatAccelerator(e.ctrlKey, e.shiftKey, e.altKey, e.metaKey, key)

  // Recording mode
  if (recordingResolve) {
    const resolve = recordingResolve
    cancelRecording()
    resolve(acc)
    return
  }

  // Matching mode
  if (acc === activeHotkey) {
    triggerToggle()
  }
}

/* ── Mouse handler ─────────────────────────────────────────────── */

function handleMouseDown(e: UiohookMouseEvent): void {
  if (!isMouseButton(e.button)) return

  const key = `Mouse${e.button}`
  const acc = formatAccelerator(e.ctrlKey, e.shiftKey, e.altKey, e.metaKey, key)

  // Recording mode
  if (recordingResolve) {
    const resolve = recordingResolve
    cancelRecording()
    resolve(acc)
    return
  }

  // Matching mode
  if (acc === activeHotkey) {
    triggerToggle()
  }
}

/* ── Default toggle implementation (used if no custom cb set) ──── */

export function toggleMagnifierVisibility(): void {
  const mw = getMagnifierWindow()
  if (!mw || mw.isDestroyed()) {
    createMagnifierWindow()
    return
  }

  if (mw.isVisible()) {
    mw.hide()
  } else {
    mw.showInactive()
    mw.setIgnoreMouseEvents(true, { forward: true })
  }
}
