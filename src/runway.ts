import { chromium } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

interface RunwayBuildResult {
  url: string | null
  filename: string | null
}

/** Resolves the Chromium executable path.
 *  - In the packaged .app, Chromium is bundled as an extraResource at
 *    <app>/Contents/Resources/chromium-bundle/chrome-mac-arm64/Google Chrome for Testing.app/...
 *  - In dev, Playwright uses its own cache automatically (no override needed).
 */
function getChromiumExecutable(): string | undefined {
  const { app } = require('electron')
  if (!app.isPackaged) return undefined  // let Playwright find its own

  const bundled = path.join(
    process.resourcesPath,
    'chromium-bundle',
    'chrome-mac-arm64',
    'Google Chrome for Testing.app',
    'Contents',
    'MacOS',
    'Google Chrome for Testing'
  )

  return fs.existsSync(bundled) ? bundled : undefined
}

export async function getLatestRunwayBuildUrl(
  bucketUrl: string,
  log: (msg: string) => void
): Promise<RunwayBuildResult> {
  const executablePath = getChromiumExecutable()

  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  })

  const context = await browser.newContext()
  const page = await context.newPage()

  let downloadUrl: string | null = null
  let filename: string | null = null

  // Intercept requests to capture the pre-signed S3 URL before it's fetched
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('.app.zip')) {
      downloadUrl = url
      const match = url.match(/\/([^/?]+\.app\.zip)/)
      if (match) filename = match[1]
    }
  })

  try {
    log('Opening Runway bucket page...')
    await page.goto(bucketUrl, { waitUntil: 'networkidle', timeout: 30000 })

    log('Finding latest build with an .app.zip artifact...')

    // Click each build row (newest first) until we find one with an artifact
    const rows = await page.locator('[class*="build"], [class*="row"], tbody tr').all()

    for (const row of rows.slice(0, 8)) {
      try {
        await row.click({ timeout: 3000 })
        await page.waitForTimeout(800)

        const artifactLink = page.locator('text=.app.zip').first()
        const visible = await artifactLink.isVisible().catch(() => false)

        if (visible) {
          log('Found artifact — capturing download URL...')
          await artifactLink.click({ timeout: 5000 })
          await page.waitForTimeout(2000)
          if (downloadUrl) break
        }
      } catch {
        continue
      }
    }
  } finally {
    await browser.close()
  }

  return { url: downloadUrl, filename }
}
