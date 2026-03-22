import { chromium } from 'playwright'

interface RunwayBuildResult {
  url: string | null
  filename: string | null
}

export async function getLatestRunwayBuildUrl(
  bucketUrl: string,
  log: (msg: string) => void
): Promise<RunwayBuildResult> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  let downloadUrl: string | null = null
  let filename: string | null = null

  // Intercept network requests to capture the pre-signed S3 URL
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

    // Click the first build row that has an artifact
    log('Finding latest build with artifact...')

    // Try each build row until we find one with an .app.zip
    const rows = await page.locator('[class*="build"], [class*="row"], tbody tr').all()

    for (const row of rows.slice(0, 5)) {
      try {
        await row.click({ timeout: 3000 })
        await page.waitForTimeout(1000)

        // Look for artifact link
        const artifactLink = page.locator('text=.app.zip').first()
        const visible = await artifactLink.isVisible().catch(() => false)

        if (visible) {
          log('Found artifact — capturing download URL...')
          // Click the artifact to trigger the pre-signed URL request
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
