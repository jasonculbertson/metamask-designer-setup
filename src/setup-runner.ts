import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getLatestRunwayBuildUrl } from './runway'

const STATE_FILE = path.join(os.homedir(), '.metamask-designer-setup.json')
const REPO_DIR = path.join(os.homedir(), 'metamask-mobile')
const RUNWAY_BUCKET = 'https://app.runway.team/bucket/aCddXOkg1p_nDryri-FMyvkC9KRqQeVT_12sf6Nw0u6iGygGo6BlNzjD6bOt-zma260EzAxdpXmlp2GQphp3TN1s6AJE4i6d_9V0Tv5h4pHISU49dFk='

type Emit = (event: string, data: unknown) => void

interface State {
  infuraKey?: string
  installedBuild?: string
  setupComplete?: boolean
}

// Async exec that streams stdout/stderr lines to the log
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))))
    proc.on('error', reject)
  })
}

function runWithLog(
  cmd: string,
  args: string[],
  log: (msg: string) => void,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const onLine = (chunk: Buffer) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => log(line))
    }
    proc.stdout?.on('data', onLine)
    proc.stderr?.on('data', onLine)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))))
    proc.on('error', reject)
  })
}

function runShell(cmd: string, log: (msg: string) => void, cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return runWithLog('/bin/bash', ['-c', cmd], log, { cwd, env })
}

function whichInEnv(bin: string, env: NodeJS.ProcessEnv): boolean {
  try {
    require('child_process').execSync(`which ${bin}`, { stdio: 'ignore', env })
    return true
  } catch { return false }
}

/** Build a full PATH string covering all common tool locations.
 *  Electron apps launch with a very minimal PATH — this ensures brew,
 *  node, corepack, yarn, git, watchman etc. are all findable. */
function buildFullPath(): string {
  const home = os.homedir()
  const extras = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.nvm/versions/node/v20/bin`,
    `${home}/.volta/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
  return [...extras, process.env.PATH || ''].join(':')
}

export class SetupRunner {
  private emit: Emit
  private state: State = {}
  // Full PATH built once at construction — all steps use this so tools are always findable
  private env: NodeJS.ProcessEnv = { ...process.env, PATH: buildFullPath() }

  constructor(emit: Emit) {
    this.emit = emit
    this.loadState()
  }

  private loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        this.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      }
    } catch { this.state = {} }
  }

  private saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2))
  }

  private log(msg: string) { this.emit('setup:log', msg) }

  private progress(step: string, status: 'running' | 'done' | 'skipped' | 'error', detail?: string) {
    this.emit('setup:progress', { step, status, detail })
  }

  getState(): State { return this.state }

  async runStep(stepId: string, payload?: Record<string, string>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      switch (stepId) {
        case 'check-xcode':       return await this.checkXcode()
        case 'install-prereqs':   return await this.installPrereqs()
        case 'save-infura-key':   return this.saveInfuraKey(payload?.key ?? '')
        case 'clone-repo':        return await this.cloneOrPullRepo()
        case 'install-deps':      return await this.installDeps()
        case 'download-build':    return await this.downloadBuild()
        case 'check-refine-ai':   return await this.checkRefineAi()
        case 'launch':            return await this.launch()
        default: return { ok: false, error: `Unknown step: ${stepId}` }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emit('setup:error', msg)
      return { ok: false, error: msg }
    }
  }

  private async checkXcode(): Promise<{ ok: boolean; error?: string }> {
    this.progress('prereqs', 'running', 'Checking Xcode...')
    try {
      require('child_process').execSync('xcode-select -p', { stdio: 'ignore' })
      if (!fs.existsSync('/Applications/Xcode.app')) throw new Error()
      this.progress('prereqs', 'running', 'Homebrew, Node 20, Yarn, Watchman')
      return { ok: true }
    } catch {
      this.progress('prereqs', 'error', 'Xcode not found')
      return { ok: false, error: 'xcode-missing' }
    }
  }

  private async installPrereqs(): Promise<{ ok: boolean; error?: string }> {
    this.progress('prereqs', 'running')
    const log = this.log.bind(this)

    const env = this.env

    // ── Check for admin rights (required by Homebrew) ──
    const isAdmin = (() => {
      try {
        const groups = require('child_process').execSync('id', { encoding: 'utf8', env }).trim()
        return groups.includes('staff') && (
          groups.includes('admin') ||
          require('child_process').execSync('dscl . -read /Groups/admin GroupMembership', { encoding: 'utf8', env })
            .includes(os.userInfo().username)
        )
      } catch { return false }
    })()

    if (!isAdmin) {
      const msg = `Your Mac account (${os.userInfo().username}) doesn't have Administrator privileges, which are required to install developer tools.\n\nTo fix this: go to System Settings → Users & Groups, select your account, and enable "Allow this user to administer this computer". You may need to ask IT for help.`
      log(`⚠️ ${msg}`)
      this.progress('prereqs', 'error', 'Admin privileges required')
      return { ok: false, error: msg }
    }

    // ── Homebrew ──
    // Detect by absolute path, NOT via which() — avoids PATH issues
    const brewBin = fs.existsSync('/opt/homebrew/bin/brew')
      ? '/opt/homebrew/bin/brew'
      : fs.existsSync('/usr/local/bin/brew')
      ? '/usr/local/bin/brew'
      : null

    if (!brewBin) {
      log('Installing Homebrew — a password prompt will appear...')
      // Prompt for password via native macOS dialog, then cache sudo credentials
      // for the CURRENT user. Homebrew must not run as root — it handles sudo
      // internally for the specific operations that need it.
      await runShell(
        `pwd=$(osascript -e 'tell app "System Events" to display dialog "MetaMask Designer Setup needs your password to install developer tools (Homebrew)." default answer "" with hidden answer buttons {"Cancel","OK"} default button "OK" with title "Administrator Password Required"' -e 'text returned of result') && echo "$pwd" | sudo -S -v 2>/dev/null && unset pwd`,
        log, undefined, env
      )
      await runShell(
        `NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`,
        log, undefined, env
      )
    } else {
      log(`Homebrew already installed ✓`)
    }

    const brew = brewBin ?? (fs.existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew')

    // ── Node 20 ──
    const nodeVersion = (() => {
      try {
        return require('child_process').execSync('node --version', { encoding: 'utf8', env }).trim()
      } catch { return '' }
    })()

    if (!nodeVersion.startsWith('v20')) {
      log(`Installing Node 20 (current: ${nodeVersion || 'none'})...`)
      await runWithLog(brew, ['install', 'node@20'], log, { env })
      await runWithLog(brew, ['link', 'node@20', '--force', '--overwrite'], log, { env })
    } else {
      log(`Node 20 already installed (${nodeVersion}) ✓`)
    }

    // ── Yarn via corepack ──
    if (!whichInEnv('yarn', env)) {
      log('Enabling Yarn via corepack...')
      // Use full path to corepack in case it's not on the shell PATH yet
      const corepackBin = (() => {
        try {
          return require('child_process').execSync('which corepack', { encoding: 'utf8', env }).trim()
        } catch { return 'corepack' }
      })()
      await runShell(`${corepackBin} enable && ${corepackBin} prepare yarn@4 --activate`, log, undefined, env)
    } else {
      log('Yarn already installed ✓')
    }

    // ── Watchman ──
    if (!whichInEnv('watchman', env)) {
      log('Installing Watchman...')
      await runWithLog(brew, ['install', 'watchman'], log, { env })
    } else {
      log('Watchman already installed ✓')
    }

    // ── Git ──
    if (!whichInEnv('git', env)) {
      log('Installing Git...')
      await runWithLog(brew, ['install', 'git'], log, { env })
    } else {
      log('Git already installed ✓')
    }

    this.progress('prereqs', 'done')
    return { ok: true }
  }

  private saveInfuraKey(key: string): { ok: boolean; error?: string } {
    if (!key || key.trim().length < 10) return { ok: false, error: 'Invalid API key' }
    this.state.infuraKey = key.trim()
    this.saveState()
    return { ok: true }
  }

  private async cloneOrPullRepo(): Promise<{ ok: boolean; error?: string }> {
    this.progress('repo', 'running')
    const log = this.log.bind(this)

    if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
      log('Pulling latest metamask-mobile...')
      await runWithLog('git', ['pull'], log, { cwd: REPO_DIR, env: this.env })
    } else {
      log('Cloning MetaMask/metamask-mobile (this may take a minute)...')
      await runWithLog('git', [
        'clone', '--depth=1',
        'https://github.com/MetaMask/metamask-mobile.git',
        REPO_DIR,
      ], log, { env: this.env })
    }

    // Write .js.env — use .js.env.example as base so all required vars are present
    const envPath = path.join(REPO_DIR, '.js.env')
    const examplePath = path.join(REPO_DIR, '.js.env.example')
    if (!fs.existsSync(envPath)) {
      if (fs.existsSync(examplePath)) {
        let template = fs.readFileSync(examplePath, 'utf8')
        template = template.replace(
          /export MM_INFURA_PROJECT_ID=.*/,
          `export MM_INFURA_PROJECT_ID="${this.state.infuraKey}"`
        )
        fs.writeFileSync(envPath, template)
        log('Created .js.env from template with your Infura key ✓')
      } else {
        fs.writeFileSync(envPath, [
          `export MM_INFURA_PROJECT_ID="${this.state.infuraKey}"`,
          'export METAMASK_ENVIRONMENT="dev"',
          'export METAMASK_BUILD_TYPE="main"',
        ].join('\n') + '\n')
        log('Created .js.env with your Infura key ✓')
      }
    } else {
      // Ensure critical build vars are present even in existing files
      let content = fs.readFileSync(envPath, 'utf8')
      let updated = false
      if (!content.includes('METAMASK_BUILD_TYPE')) {
        content += '\nexport METAMASK_BUILD_TYPE="main"\n'
        updated = true
      }
      if (!content.includes('METAMASK_ENVIRONMENT')) {
        content += '\nexport METAMASK_ENVIRONMENT="dev"\n'
        updated = true
      }
      if (updated) {
        fs.writeFileSync(envPath, content)
        log('.js.env updated with required build vars ✓')
      } else {
        log('.js.env already exists — leaving untouched ✓')
      }
    }

    this.progress('repo', 'done')
    return { ok: true }
  }

  private async installDeps(): Promise<{ ok: boolean; error?: string }> {
    this.progress('deps', 'running')
    const log = this.log.bind(this)

    // Skip only if node_modules AND Yarn's state file both exist (Yarn Berry requirement)
    const modulesExist = fs.existsSync(path.join(REPO_DIR, 'node_modules'))
    const yarnStateExists = fs.existsSync(path.join(REPO_DIR, '.yarn', 'install-state.gz'))
    if (modulesExist && yarnStateExists) {
      log('Dependencies already installed — skipping ✓')
      this.progress('deps', 'skipped')
      return { ok: true }
    }

    log('Running yarn install...')
    await runWithLog('yarn', ['install'], log, { cwd: REPO_DIR, env: this.env })

    log('Running yarn setup:expo — this takes 5-10 minutes...')
    await runWithLog('yarn', ['setup:expo'], log, { cwd: REPO_DIR, env: this.env })

    this.progress('deps', 'done')
    return { ok: true }
  }

  private async downloadBuild(): Promise<{ ok: boolean; error?: string }> {
    this.progress('build', 'running')
    const log = this.log.bind(this)

    log('Checking latest Runway build...')
    const result = await getLatestRunwayBuildUrl(RUNWAY_BUCKET, log)

    if (!result.url || !result.filename) {
      return { ok: false, error: 'Could not find a build with an .app.zip on Runway' }
    }

    const buildId = result.filename.replace('.app.zip', '')

    if (this.state.installedBuild === buildId) {
      log(`Build ${buildId} already installed ✓`)
      this.progress('build', 'skipped', buildId)
      return { ok: true }
    }

    const zipPath = path.join(os.tmpdir(), result.filename)

    // If the zip already exists from a previous run, ask the designer whether to reuse it
    let skipDownload = false
    if (fs.existsSync(zipPath)) {
      const stat = fs.statSync(zipPath)
      const ageMins = Math.round((Date.now() - stat.mtimeMs) / 60000)
      const { dialog, BrowserWindow } = require('electron')
      const win = BrowserWindow.getAllWindows()[0]
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Use existing download', 'Download fresh'],
        defaultId: 0,
        title: 'Build already downloaded',
        message: `A build was already downloaded ${ageMins < 60 ? `${ageMins} min` : `${Math.round(ageMins / 60)}h`} ago.`,
        detail: `Use the existing file to save time, or download the latest from Runway.`,
      })
      skipDownload = response === 0
      if (skipDownload) log(`Reusing existing download (${ageMins} min old) ✓`)
    }

    if (!skipDownload) {
      log(`Downloading ${result.filename}...`)
      await runWithLog('curl', ['-L', '--progress-bar', '-o', zipPath, result.url], log, { env: this.env })
    }

    const appDir = path.join(os.tmpdir(), 'metamask-sim-app')
    fs.rmSync(appDir, { recursive: true, force: true })
    fs.mkdirSync(appDir, { recursive: true })

    log('Unzipping...')
    await runWithLog('unzip', ['-o', zipPath, '-d', appDir], log, { env: this.env })

    log('Booting Simulator...')
    await runShell('xcrun simctl boot "iPhone 16" 2>/dev/null || xcrun simctl boot "iPhone 15" 2>/dev/null || true', log, undefined, this.env)

    // Find the .app bundle — handle both nested (.app folder inside zip) and
    // flat (zip extracted .app contents directly into appDir) zip structures
    let appPath: string | undefined = require('child_process')
      .execSync(`find "${appDir}" -name "*.app" -maxdepth 3`, { encoding: 'utf8', env: this.env })
      .split('\n').filter(Boolean)[0]

    if (!appPath && fs.existsSync(path.join(appDir, 'Info.plist'))) {
      // The zip extracted the .app bundle contents flat — rename appDir to MetaMask.app
      const renamedPath = path.join(os.tmpdir(), 'MetaMask.app')
      if (fs.existsSync(renamedPath)) fs.rmSync(renamedPath, { recursive: true, force: true })
      fs.renameSync(appDir, renamedPath)
      appPath = renamedPath
      log('Detected flat .app bundle structure ✓')
    }

    if (!appPath) throw new Error('Could not find .app bundle in downloaded zip')

    log(`Installing ${path.basename(appPath)} into Simulator...`)
    await runWithLog('xcrun', ['simctl', 'install', 'booted', appPath], log, { env: this.env })

    this.state.installedBuild = buildId
    this.saveState()

    this.progress('build', 'done', buildId)
    return { ok: true }
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    this.progress('launch', 'running')
    const log = this.log.bind(this)

    // ── Step 1: Boot simulator ──
    log('Opening Simulator...')
    await run('open', ['-a', 'Simulator'])
    await new Promise(r => setTimeout(r, 3000))

    // ── Step 2: Start bundler FIRST, logging to a file so we can debug ──
    const bundlerLog = path.join(os.tmpdir(), 'metamask-bundler.log')
    log(`Starting Metro bundler (log: ${bundlerLog})...`)
    const logFd = require('fs').openSync(bundlerLog, 'w')
    const bundler = spawn('yarn', ['watch:clean'], {
      cwd: REPO_DIR,
      env: { ...this.env, METAMASK_ENVIRONMENT: 'dev', METAMASK_BUILD_TYPE: 'main' },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    bundler.unref()

    // ── Step 3: Wait for Metro to be ready on port 8081 (max 3 min) ──
    const bundlerReady = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const maxWait = 180000
      let elapsed = 0
      const poll = () => {
        elapsed = Math.round((Date.now() - start) / 1000)
        try {
          require('child_process').execSync(
            'curl -sf http://localhost:8081/status > /dev/null',
            { env: this.env, stdio: 'ignore' }
          )
          resolve(true)
        } catch {
          // Show last line of bundler log so user can see what's happening
          try {
            const lastLine = require('child_process')
              .execSync(`tail -1 "${bundlerLog}"`, { encoding: 'utf8', env: this.env })
              .trim()
            if (lastLine) log(`Bundler (${elapsed}s): ${lastLine}`)
            else log(`Waiting for bundler... ${elapsed}s`)
          } catch { log(`Waiting for bundler... ${elapsed}s`) }

          if (Date.now() - start < maxWait) {
            setTimeout(poll, 5000)
          } else {
            resolve(false)
          }
        }
      }
      setTimeout(poll, 8000)
    })

    if (bundlerReady) {
      log('Bundler is ready ✓')
    } else {
      log('Bundler taking longer than expected — continuing anyway')
    }

    // ── Step 3b: Pre-compile the bundle so the app connects instantly ──
    // Metro passes /status before the bundle is compiled — we hit the bundle
    // endpoint directly so it's cached by the time the app opens.
    log('Pre-compiling JS bundle (this takes 1-2 min the first time)...')
    await runShell(
      'curl -sf --max-time 300 "http://localhost:8081/index.bundle?platform=ios&dev=true&minify=false" -o /dev/null 2>/dev/null || true',
      log, undefined, this.env
    )
    log('Bundle ready ✓')

    // ── Step 4: Launch MetaMask and auto-connect via deep link ──
    log('Launching MetaMask in Simulator...')
    const bundlerUrl = encodeURIComponent('http://localhost:8081')
    await runShell(`xcrun simctl launch booted io.metamask.MetaMask 2>/dev/null || true`, log, undefined, this.env)
    await new Promise(r => setTimeout(r, 3000))
    await runShell(
      `xcrun simctl openurl booted "expo-metamask://expo-development-client/?url=${bundlerUrl}" 2>/dev/null || true`,
      log, undefined, this.env
    )

    // ── Step 5: Launch Refine AI ──
    // Small delay so macOS finishes processing the MetaMask deep link first
    await new Promise(r => setTimeout(r, 2000))
    log('Launching Refine AI...')
    const refineUserApp = path.join(os.homedir(), 'Applications', 'Refine AI.app')
    const refineCmd = require('fs').existsSync(refineUserApp)
      ? `open "${refineUserApp}"`
      : 'open -a "Refine AI"'
    await runShell(`${refineCmd} 2>/dev/null || true`, log, undefined, this.env)

    this.state.setupComplete = true
    this.saveState()

    this.progress('launch', 'done')
    return { ok: true }
  }

  private async checkRefineAi(): Promise<{ ok: boolean; error?: string }> {
    this.progress('refine-ai', 'running', 'Checking Refine AI...')
    const log = this.log.bind(this)
    const https = require('https')
    const REFINE_AI_PATHS = [
      '/Applications/Refine AI.app',
      path.join(os.homedir(), 'Applications', 'Refine AI.app'),
    ]
    const INSTALL_DIR = path.join(os.homedir(), 'Applications')
    const REFINE_AI_DEST = path.join(INSTALL_DIR, 'Refine AI.app')
    const RELEASES_API = 'https://api.github.com/repos/jasonculbertson/refine-ai-releases/releases/latest'

    // Hardcoded fallback in case GitHub API is rate-limited
    const FALLBACK_VERSION = '1.1.2'
    const FALLBACK_DMG_URL = 'https://github.com/jasonculbertson/refine-ai-releases/releases/download/v1.1.2/Refine.AI-1.1.2-arm64.dmg'
    const FALLBACK_DMG_NAME = 'Refine.AI-1.1.2-arm64.dmg'

    // Fetch latest release info from GitHub
    const latestRelease = await new Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] } | null>((resolve) => {
      https.get(RELEASES_API, { headers: { 'User-Agent': 'metamask-designer-setup' } }, (res: any) => {
        let data = ''
        res.on('data', (chunk: any) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve(null) }
        })
      }).on('error', () => resolve(null))
    })

    const latestVersion = latestRelease?.tag_name?.replace(/^v/, '') ?? FALLBACK_VERSION
    const dmgAsset = latestRelease?.assets?.find((a: any) => a.name.endsWith('.dmg'))
      ?? { name: FALLBACK_DMG_NAME, browser_download_url: FALLBACK_DMG_URL }

    if (!latestRelease) {
      log(`GitHub API unavailable — using known version ${FALLBACK_VERSION}`)
    }

    // Check currently installed version (both locations)
    const installedVersion = (() => {
      for (const appPath of REFINE_AI_PATHS) {
        try {
          const out = require('child_process').execSync(
            `defaults read "${appPath}/Contents/Info.plist" CFBundleShortVersionString`,
            { encoding: 'utf8', env: this.env }
          ).trim()
          if (out) return out
        } catch { /* try next */ }
      }
      return null
    })()

    if (installedVersion === latestVersion) {
      log(`Refine AI ${latestVersion} already installed ✓`)
      this.progress('refine-ai', 'done', `v${latestVersion} ✓`)
      return { ok: true }
    }

    if (installedVersion) {
      log(`Updating Refine AI ${installedVersion} → ${latestVersion}...`)
    } else {
      log(`Installing Refine AI ${latestVersion}...`)
    }

    const dmgPath = path.join(os.tmpdir(), dmgAsset.name)
    await runWithLog('curl', ['-L', '--progress-bar', '-o', dmgPath, dmgAsset.browser_download_url], log, { env: this.env })

    log('Mounting disk image...')
    const attachOut = require('child_process').execSync(
      `hdiutil attach "${dmgPath}" -nobrowse -noverify`,
      { encoding: 'utf8', env: this.env }
    )
    const volMatch = attachOut.match(/\/Volumes\/[^\n\t]+/)
    if (!volMatch) throw new Error('Could not find mount point for Refine AI disk image')
    const vol = volMatch[0].trim()

    require('fs').mkdirSync(INSTALL_DIR, { recursive: true })
    await runShell(`rm -rf "${REFINE_AI_DEST}"`, log, undefined, this.env)
    log('Copying Refine AI to ~/Applications...')
    await runShell(`cp -R "${vol}/Refine AI.app" "${REFINE_AI_DEST}"`, log, undefined, this.env)
    await runShell(`hdiutil detach "${vol}" -quiet || true`, log, undefined, this.env)
    try { require('fs').unlinkSync(dmgPath) } catch { /* ignore */ }

    log(`Refine AI ${latestVersion} installed ✓`)
    this.progress('refine-ai', 'done', `v${latestVersion}`)
    return { ok: true }
  }
}
