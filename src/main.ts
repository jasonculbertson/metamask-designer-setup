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

  win.loadFile(path.join(__dirname, '../src/index.html'))
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

// Open external links in default browser
ipcMain.on('open-url', (_e, url: string) => {
  shell.openExternal(url)
})

// Run a named setup step
ipcMain.handle('run-step', async (_e, stepId: string, payload?: Record<string, string>) => {
  if (!runner) return { ok: false, error: 'Runner not ready' }
  return runner.runStep(stepId, payload)
})

// Check current state (for resume on relaunch)
ipcMain.handle('get-state', async () => {
  if (!runner) return {}
  return runner.getState()
})
