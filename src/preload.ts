import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  openUrl: (url: string) => ipcRenderer.send('open-url', url),
  runStep: (stepId: string, payload?: Record<string, string>) =>
    ipcRenderer.invoke('run-step', stepId, payload),
  getState: () => ipcRenderer.invoke('get-state'),
  onProgress: (cb: (event: string, data: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: unknown) => cb('progress', data)
    const logHandler = (_: Electron.IpcRendererEvent, data: unknown) => cb('log', data)
    const errorHandler = (_: Electron.IpcRendererEvent, data: unknown) => cb('error', data)
    ipcRenderer.on('setup:progress', handler)
    ipcRenderer.on('setup:log', logHandler)
    ipcRenderer.on('setup:error', errorHandler)
    return () => {
      ipcRenderer.removeListener('setup:progress', handler)
      ipcRenderer.removeListener('setup:log', logHandler)
      ipcRenderer.removeListener('setup:error', errorHandler)
    }
  },
})
