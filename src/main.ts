import { app, BrowserWindow, ipcMain, shell } from 'electron'
import * as path from 'path'
import { SetupRunner } from './setup-runner'

let win: BrowserWindow | null = null
let runner: SetupRunner | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 680,
    height: 780,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      // Use app.getAppPath() for both preload and HTML — works correctly in asar and dev
      preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const htmlPath = path.join(app.getAppPath(), 'src', 'index.html')
  win.loadFile(htmlPath)

  // win.webContents.openDevTools()
}

app.whenReady().then(() => {
  createWindow()
  runner = new SetupRunner((event, data) => {
    win?.webContents.send(event, data)
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  runner?.cleanup()
})

ipcMain.on('open-url', (_e, url: string) => {
  shell.openExternal(url)
})

ipcMain.handle('run-step', async (_e, stepId: string, payload?: Record<string, string>) => {
  if (!runner) return { ok: false, error: 'Runner not ready' }
  return runner.runStep(stepId, payload)
})

ipcMain.handle('get-state', async () => {
  if (!runner) return {}
  return runner.getState()
})
