import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
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
  autoUpdater.logger = require('electron-log')
  ;(autoUpdater.logger as any).transports.file.level = 'info'

  autoUpdater.on('checking-for-update', () => {
    win?.webContents.send('app:update-status', { status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    win?.webContents.send('app:update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes,
    })
    win?.webContents.send('app:update-status', { status: 'available', version: info.version })
    rebuildMenu()
  })

  autoUpdater.on('update-not-available', () => {
    win?.webContents.send('app:update-status', { status: 'up-to-date' })
  })

  autoUpdater.on('error', (err) => {
    win?.webContents.send('app:update-status', { status: 'error', message: err.message })
  })

  autoUpdater.on('download-progress', (progress) => {
    win?.webContents.send('app:update-status', {
      status: 'downloading',
      percent: Math.round(progress.percent),
    })
    rebuildMenu()
  })

  autoUpdater.on('update-downloaded', () => {
    win?.webContents.send('app:update-status', { status: 'ready' })
    rebuildMenu()
    const { dialog } = require('electron')
    dialog.showMessageBox(win!, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      title: 'Update Ready',
      message: `A new version of MetaMask Designer Setup has been downloaded. Restart to apply it.`,
    }).then(({ response }: { response: number }) => {
      if (response === 0) autoUpdater.quitAndInstall()
    })
  })

  // Wait for window to finish loading before first check
  win!.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch((e) => {
        win?.webContents.send('app:update-status', { status: 'error', message: e.message })
      })
    }, 3000)
  })

  // Re-check every hour
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 60 * 60 * 1000)
}

let updateState = 'idle'

function rebuildMenu() {
  const checkLabel = updateState === 'downloading'
    ? 'Downloading Update…'
    : updateState === 'ready'
    ? 'Restart to Apply Update'
    : 'Check for Updates'

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        {
          label: checkLabel,
          click: () => {
            if (updateState === 'ready') {
              autoUpdater.quitAndInstall()
            } else {
              autoUpdater.checkForUpdatesAndNotify().catch(() => {})
            }
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

ipcMain.on('update-state-changed', (_e, state: string) => {
  updateState = state
  rebuildMenu()
})

app.whenReady().then(() => {
  rebuildMenu()
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
