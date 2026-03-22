/**
 * Copies the locally-installed Playwright Chromium into chromium-bundle/
 * so electron-builder can include it as an extraResource in the .dmg.
 *
 * Playwright installs Chromium to ~/Library/Caches/ms-playwright/chromium-XXXX/
 * The exact revision number changes with each Playwright release.
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CACHE_DIR = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
const DEST = path.join(__dirname, '..', 'chromium-bundle')

// Find the latest chromium-XXXX directory
const dirs = fs.readdirSync(CACHE_DIR).filter(d => d.startsWith('chromium-')).sort()
if (!dirs.length) {
  console.error('No Playwright Chromium found in', CACHE_DIR)
  console.error('Run: npx playwright install chromium')
  process.exit(1)
}

const chromiumDir = path.join(CACHE_DIR, dirs[dirs.length - 1])
console.log(`Copying ${chromiumDir} → chromium-bundle/`)

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true })
}

execSync(`cp -R "${chromiumDir}" "${DEST}"`)
console.log('✓ chromium-bundle ready for packaging')
