import { app, BrowserWindow, ipcMain, shell } from 'electron'
import * as path from 'path'
import { SetupRunner } from './setup-runner'
import { autoUpdater } from 'electron-updater'

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
      preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const htmlPath = path.join(app.getAppPath(), 'src', 'index.html')
  win.loadFile(htmlPath)

  // win.webContents.openDevTools()
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    win?.webContents.send('app:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    })
  })

  autoUpdater.on('update-downloaded', () => {
    const { dialog } = require('electron')
    dialog.showMessageBox(win!, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      title: 'Update Ready',
      message: 'A new version has been downloaded. Restart now to apply it.',
    }).then(({ response }: { response: number }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })

  // Wait for window to load before first check so the banner is visible
  win!.webContents.once('did-finish-load', () => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  })

  // Re-check every hour while the app is open
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 60 * 60 * 1000)
}

app.whenReady().then(() => {
  createWindow()
  runner = new SetupRunner((event, data) => {
    win?.webContents.send(event, data)
  })
  setupAutoUpdater()
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
