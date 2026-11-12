import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureSourceDTO, MagnifierSettings, RenderModeFeatures } from '../main/types'

const api = {
  controlWindow: (action: 'minimize' | 'toggle-maximize' | 'close'): Promise<void> => ipcRenderer.invoke('window:control', action),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  },
  getSettings: (): Promise<MagnifierSettings> => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: MagnifierSettings): Promise<MagnifierSettings> => ipcRenderer.invoke('settings:set', settings),
  getRenderModeFeatures: (): Promise<RenderModeFeatures> => ipcRenderer.invoke('features:get-render-modes'),
  getCaptureSources: (): Promise<CaptureSourceDTO[]> => ipcRenderer.invoke('capture:get-sources'),
  onSettingsChanged: (callback: (settings: MagnifierSettings) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: MagnifierSettings) => callback(settings)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  startHotkeyRecording: (): Promise<string> => ipcRenderer.invoke('hotkey:start-recording'),
  cancelHotkeyRecording: (): void => { void ipcRenderer.invoke('hotkey:cancel-recording') },
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
