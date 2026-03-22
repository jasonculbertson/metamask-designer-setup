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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // In production (asar), index.html is in src/ relative to app root
  const htmlPath = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'src', 'index.html')
    : path.join(__dirname, '..', 'src', 'index.html')

  win.loadFile(htmlPath)
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
