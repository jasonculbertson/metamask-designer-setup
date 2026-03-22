import { BrowserWindow } from 'electron'

interface RunwayBuildResult {
  url: string | null
  filename: string | null
}

/**
 * Opens the Runway bucket page in a visible window so the designer can
 * click the latest build's .app.zip download. We intercept the pre-signed
 * URL automatically via the will-download event — no automation needed.
 */
export async function getLatestRunwayBuildUrl(
  bucketUrl: string,
  log: (msg: string) => void
): Promise<RunwayBuildResult> {
  return new Promise((resolve) => {
    let resolved = false

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Select a MetaMask Build to Download',
      webPreferences: {
        partition: 'persist:runway',
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    const done = (url: string | null, filename: string | null) => {
      if (resolved) return
      resolved = true
      try { win.destroy() } catch { /* already destroyed */ }
      resolve({ url, filename })
    }

    // Capture the pre-signed URL the moment a download is triggered
    win.webContents.session.on('will-download', (_event, item) => {
      const url = item.getURL()
      if (url.includes('.app.zip') || url.includes('.zip')) {
        item.cancel()  // don't save to disk — we'll download with curl
        const match = url.match(/\/([^/?#]+\.app\.zip)/)
        const filename = match ? match[1] : `metamask-${Date.now()}.app.zip`
        log(`✓ Got build URL: ${filename}`)
        done(url, filename)
      }
    })

    // If designer closes the window without clicking a download
    win.on('closed', () => done(null, null))

    // Inject a persistent instruction banner after the page loads
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(`
        const banner = document.createElement('div')
        banner.style.cssText = [
          'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
          'background:#f6851b', 'color:#fff', 'font-family:sans-serif',
          'font-size:14px', 'font-weight:600', 'padding:12px 20px',
          'display:flex', 'align-items:center', 'gap:10px',
          'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
        ].join(';')
        banner.innerHTML = '🦊 <span>Click the latest build, then click the <strong>.app.zip</strong> file to download — the window will close automatically.</span>'
        document.body.prepend(banner)
        document.body.style.paddingTop = '48px'
      `).catch(() => {})
    })

    log('Opening Runway — please click the latest build and download the .app.zip...')
    win.loadURL(bucketUrl)
  })
}
