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
  currentBranch?: string
  currentPr?: { number: number; title: string; author: string; branch: string } | null
}

const GITHUB_REPO = 'MetaMask/metamask-mobile'
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`

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
  private bundlerPid: number | null = null
  // Full PATH built once at construction — all steps use this so tools are always findable.
  // DEVELOPER_DIR ensures xcrun/simctl resolve to the full Xcode, not just Command Line Tools.
  private env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: buildFullPath(),
    DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
  }

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

  getState(): State {
    if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
      try {
        this.state.currentBranch = require('child_process')
          .execSync('git branch --show-current', { encoding: 'utf8', cwd: REPO_DIR, env: this.env })
          .trim()
        // Clear stale PR info if we're on a different branch
        if (this.state.currentPr && this.state.currentBranch !== this.state.currentPr.branch) {
          this.state.currentPr = null
        }
      } catch { /* ignore */ }
    }
    return this.state
  }

  cleanup() {
    if (this._bundlerMonitor) {
      clearInterval(this._bundlerMonitor)
      this._bundlerMonitor = null
    }
    if (this.bundlerPid) {
      try { process.kill(-this.bundlerPid) } catch { /* already gone */ }
      try { process.kill(this.bundlerPid) } catch { /* already gone */ }
      this.bundlerPid = null
    }
  }

  async runStep(stepId: string, payload?: Record<string, string>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      switch (stepId) {
        case 'check-xcode':       return await this.checkXcode()
        case 'check-homebrew':    return this.checkHomebrew()
        case 'install-prereqs':   return await this.installPrereqs()
        case 'save-infura-key':   return this.saveInfuraKey(payload?.key ?? '')
        case 'clone-repo':        return await this.cloneOrPullRepo()
        case 'install-deps':      return await this.installDeps()
        case 'download-build':    return await this.downloadBuild()
        case 'check-refine-ai':   return await this.checkRefineAi()
        case 'launch':            return await this.launch()
        case 'list-prs':          return await this.listPrs(payload?.query ?? '')
        case 'lookup-pr':         return await this.lookupPr(payload?.pr ?? '')
        case 'switch-to-pr':      return await this.switchToPr(payload?.pr ?? '')
        case 'switch-to-main':    return await this.switchBranch('main')
        case 'restart-bundler':   return await this.restartBundler()
        case 'toggle-appearance': return this.toggleAppearance(payload?.mode ?? 'dark')
        case 'reload-js':        return await this.reloadJs()
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

  private checkHomebrew(): { ok: boolean; error?: string } {
    const found = fs.existsSync('/opt/homebrew/bin/brew') || fs.existsSync('/usr/local/bin/brew')
    if (!found) return { ok: false, error: 'homebrew-missing' }
    return { ok: true }
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
      this.progress('prereqs', 'error', 'Homebrew not found')
      return { ok: false, error: 'homebrew-missing' }
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
      const corepackBin = (() => {
        try {
          return require('child_process').execSync('which corepack', { encoding: 'utf8', env }).trim()
        } catch { return 'corepack' }
      })()
      // corepack enable may need sudo if the Node bin dir isn't user-writable
      try {
        await runShell(`${corepackBin} enable && ${corepackBin} prepare yarn@4 --activate`, log, undefined, env)
      } catch {
        log('corepack enable failed — retrying with sudo...')
        await runShell(`sudo ${corepackBin} enable && ${corepackBin} prepare yarn@4 --activate`, log, undefined, env)
      }
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
      // Only pull if on main — pulling on a PR branch would fail or pull wrong code
      const currentBranch = this.getCurrentBranch()
      if (!currentBranch || currentBranch === 'main') {
        log('Pulling latest metamask-mobile...')
        await runWithLog('git', ['pull'], log, { cwd: REPO_DIR, env: this.env })
          .catch(() => log('Pull skipped — working tree may have local changes'))
      } else {
        log(`Skipping pull — on branch "${currentBranch}" (use Switch PR to update)`)
      }
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

  private bootSimulator(log: (msg: string) => void): { ok: boolean; error?: string } {
    // Check if any simulator is already booted first — avoid booting multiple
    try {
      const bootedCheck = require('child_process').execSync(
        'xcrun simctl list devices booted -j', { encoding: 'utf8', env: this.env }
      )
      const bootedDevices = JSON.parse(bootedCheck)
      const anyBooted = Object.values(bootedDevices.devices as Record<string, any[]>)
        .flat().some((d: any) => d.state === 'Booted')
      if (anyBooted) {
        log('Simulator already booted ✓')
        return { ok: true }
      }
    } catch { /* continue to boot */ }

    // No simulator booted — boot the best available iPhone
    const preferredDevices = ['iPhone 16', 'iPhone 16 Pro', 'iPhone 15', 'iPhone 15 Pro']
    for (const device of preferredDevices) {
      try {
        require('child_process').execSync(`xcrun simctl boot "${device}" 2>/dev/null`, { env: this.env, stdio: 'pipe' })
        log(`Booted ${device} ✓`)
        return { ok: true }
      } catch { /* try next */ }
    }

    // Fall back to any available iPhone
    try {
      const udid = require('child_process').execSync(
        `xcrun simctl list devices available -j | python3 -c "import sys,json; devs=json.load(sys.stdin)['devices']; phones=[d['udid'] for r in devs for d in devs[r] if 'iPhone' in d.get('name','') and d.get('state')=='Shutdown']; print(phones[0] if phones else '')"`,
        { encoding: 'utf8', env: this.env }
      ).trim()
      if (udid) {
        require('child_process').execSync(`xcrun simctl boot "${udid}"`, { env: this.env, stdio: 'pipe' })
        log('Simulator booted ✓')
        return { ok: true }
      }
    } catch { /* fall through */ }

    log('No simulator could be booted. Open Xcode → Settings → Platforms and install an iOS Simulator runtime.')
    return { ok: false, error: 'No iOS Simulator available. Open Xcode → Settings → Platforms and download an iOS Simulator runtime, then try again.' }
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
      // Verify the app is actually installed — don't just trust saved state
      const actuallyInstalled = (() => {
        try {
          require('child_process').execSync(
            'xcrun simctl get_app_container booted io.metamask.MetaMask',
            { env: this.env, stdio: 'ignore' }
          )
          return true
        } catch { return false }
      })()
      if (actuallyInstalled) {
        log(`Build ${buildId} already installed ✓`)
        this.progress('build', 'skipped', buildId)
        return { ok: true }
      }
      log(`Build ${buildId} was installed previously but is missing from Simulator — reinstalling...`)
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
    const bootStatus = this.bootSimulator(log)
    if (!bootStatus.ok) return bootStatus

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

    // Validate bundle ID — catches corrupted extractions before Simulator errors out
    const bundleId = this.readBundleId(appPath)
    if (!bundleId) {
      throw new Error(`Downloaded build is missing bundle ID (Info.plist invalid). Try "New Runway Build" again.`)
    }
    log(`Build bundle ID: ${bundleId}`)

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
    log('Booting Simulator...')
    const bootStatus = this.bootSimulator(log)
    if (!bootStatus.ok) return bootStatus
    await run('open', ['-a', 'Simulator'])
    await new Promise(r => setTimeout(r, 2000))

    // ── Step 1b: Ensure corepack/yarn shims exist for Homebrew Node ──
    try {
      require('child_process').execSync('corepack enable 2>/dev/null || sudo corepack enable 2>/dev/null || true', {
        env: this.env, stdio: 'ignore',
      })
    } catch { /* best-effort */ }

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
    this.bundlerPid = bundler.pid ?? null
    bundler.unref()
    this.monitorBundler()

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

    // ── Step 4: Ensure MetaMask is installed, then launch ──
    const isInstalled = (() => {
      try {
        require('child_process').execSync(
          'xcrun simctl get_app_container booted io.metamask.MetaMask',
          { env: this.env, stdio: 'ignore' }
        )
        return true
      } catch { return false }
    })()

    if (!isInstalled) {
      log('MetaMask not found in Simulator — reinstalling from cached build...')
      const appPath = this.findValidCachedApp(log)

      if (appPath) {
        await runWithLog('xcrun', ['simctl', 'install', 'booted', appPath], log, { env: this.env })
        log('MetaMask reinstalled ✓')
      } else {
        log('No valid cached build found — downloading fresh from Runway...')
        const buildResult = await this.downloadBuild()
        if (!buildResult.ok) return buildResult
      }
    }

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

  private async githubGet(endpoint: string): Promise<any> {
    const https = require('https')
    const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API}${endpoint}`
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'metamask-designer-setup', Accept: 'application/vnd.github+json' } }, (res: any) => {
        let data = ''
        res.on('data', (chunk: any) => data += chunk)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) }
          catch { reject(new Error(`GitHub API returned invalid JSON`)) }
        })
      }).on('error', reject)
    })
  }

  private async listPrs(query: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      const prs = await this.githubGet(`/pulls?state=open&sort=updated&direction=desc&per_page=30`)
      if (!Array.isArray(prs)) {
        return { ok: false, error: prs?.message || 'GitHub API error' }
      }

      const q = query.toLowerCase().trim()
      const mapped = prs.map((pr: any) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? '',
        branch: pr.head?.ref ?? '',
        labels: (pr.labels ?? []).map((l: any) => l.name),
        draft: pr.draft ?? false,
        updated: pr.updated_at,
      }))

      const filtered = q
        ? mapped.filter((pr: any) =>
            pr.title.toLowerCase().includes(q) ||
            pr.author.toLowerCase().includes(q) ||
            String(pr.number).includes(q) ||
            pr.labels.some((l: string) => l.toLowerCase().includes(q))
          )
        : mapped

      const current = this.getCurrentBranch()
      const activePr = this.state.currentPr ?? null

      return { ok: true, data: { prs: filtered, currentBranch: current, activePr } }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async lookupPr(input: string): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    const prNumber = this.parsePrInput(input)
    if (!prNumber) return { ok: false, error: 'Enter a PR number or paste a GitHub PR URL' }

    try {
      const pr = await this.githubGet(`/pulls/${prNumber}`)
      if (pr.message) return { ok: false, error: `PR #${prNumber}: ${pr.message}` }

      return {
        ok: true,
        data: {
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? '',
          branch: pr.head?.ref ?? '',
          description: (pr.body ?? '').slice(0, 500),
          labels: (pr.labels ?? []).map((l: any) => l.name),
          draft: pr.draft ?? false,
        },
      }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private async switchToPr(input: string): Promise<{ ok: boolean; error?: string }> {
    const prNumber = this.parsePrInput(input)
    if (!prNumber) return { ok: false, error: 'Enter a PR number or paste a GitHub PR URL' }

    const log = this.log.bind(this)
    log(`Looking up PR #${prNumber}...`)

    const pr = await this.githubGet(`/pulls/${prNumber}`)
    if (pr.message) return { ok: false, error: `PR #${prNumber}: ${pr.message}` }

    const branch = pr.head?.ref
    if (!branch) return { ok: false, error: 'Could not determine branch for this PR' }

    log(`PR #${prNumber}: ${pr.title}`)
    log(`Branch: ${branch} by ${pr.user?.login}`)

    return await this.switchBranchInternal(branch, {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? '',
      branch,
    })
  }

  private async switchBranch(branch: string): Promise<{ ok: boolean; error?: string }> {
    if (!branch) return { ok: false, error: 'No branch specified' }
    return await this.switchBranchInternal(branch, null)
  }

  private async switchBranchInternal(
    branch: string,
    prInfo: { number: number; title: string; author: string; branch: string } | null
  ): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)
    const exec = (cmd: string) => require('child_process').execSync(cmd, { encoding: 'utf8', cwd: REPO_DIR, env: this.env }).trim()

    this.cleanup()
    log(`Stopping bundler...`)
    await new Promise(r => setTimeout(r, 1000))

    // Remove stale lock file if present — causes git exit 128
    try {
      const lockFile = require('path').join(REPO_DIR, '.git', 'index.lock')
      if (require('fs').existsSync(lockFile)) {
        require('fs').unlinkSync(lockFile)
        log('Removed stale .git/index.lock')
      }
    } catch { /* ignore */ }

    // Need to unshallow if the repo was cloned with --depth=1
    try {
      const isShallow = exec('git rev-parse --is-shallow-repository')
      if (isShallow === 'true') {
        log('Fetching full history (one-time, needed for branch switching)...')
        await runWithLog('git', ['fetch', '--unshallow'], log, { cwd: REPO_DIR, env: this.env })
      }
    } catch { /* not shallow or git error — continue */ }

    // Discard any local changes — force clean slate before switching
    try {
      await runWithLog('git', ['reset', '--hard', 'HEAD'], log, { cwd: REPO_DIR, env: this.env })
      await runWithLog('git', ['clean', '-fd'], log, { cwd: REPO_DIR, env: this.env })
    } catch { /* ignore */ }

    // Fetch ONLY the specific branch by name — this is the key fix for shallow clones.
    // `git fetch origin` on a shallow clone only updates the default branch (main),
    // so `origin/<branch>` never exists for PR branches. Fetching by name always works.
    log(`Fetching branch "${branch}" from GitHub...`)
    await runWithLog('git', ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`, '--update-shallow'], log, { cwd: REPO_DIR, env: this.env })
      .catch(() =>
        // Fallback without --update-shallow for non-shallow repos
        runWithLog('git', ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], log, { cwd: REPO_DIR, env: this.env })
      )
      .catch((e: Error) => { throw new Error(`Could not fetch branch "${branch}" from GitHub — is the PR still open? (${e.message})`) })

    log(`Switching to ${branch}...`)
    // -B creates or resets the branch to track origin/<branch>
    await runWithLog('git', ['checkout', '-B', branch, `origin/${branch}`], log, { cwd: REPO_DIR, env: this.env })
      .catch((e: Error) => { throw new Error(`Could not switch to "${branch}": ${e.message}`) })

    log('Pulling latest...')
    await runWithLog('git', ['pull', '--ff-only'], log, { cwd: REPO_DIR, env: this.env })
      .catch(() => { log('Already up to date') })

    log('Reinstalling dependencies...')
    await runWithLog('yarn', ['install'], log, { cwd: REPO_DIR, env: this.env })

    this.state.currentBranch = branch
    this.state.currentPr = prInfo
    this.saveState()
    log(`Switched to ${branch} ✓`)
    return { ok: true }
  }

  private parsePrInput(input: string): number | null {
    if (!input) return null
    const trimmed = input.trim()
    // Full URL: https://github.com/MetaMask/metamask-mobile/pull/28576
    const urlMatch = trimmed.match(/\/pull\/(\d+)/)
    if (urlMatch) return parseInt(urlMatch[1], 10)
    // Just a number: 28576 or #28576
    const numMatch = trimmed.match(/^#?(\d+)$/)
    if (numMatch) return parseInt(numMatch[1], 10)
    return null
  }

  private getCurrentBranch(): string {
    try {
      return require('child_process')
        .execSync('git branch --show-current', { encoding: 'utf8', cwd: REPO_DIR, env: this.env })
        .trim()
    } catch { return '' }
  }

  private async restartBundler(): Promise<{ ok: boolean; error?: string }> {
    const log = this.log.bind(this)
    log('Stopping bundler...')
    this.cleanup()
    // Also kill anything on port 8081 in case a stale process is hanging
    try {
      require('child_process').execSync('lsof -ti:8081 | xargs kill -9 2>/dev/null || true', { env: this.env, stdio: 'ignore' })
    } catch { /* nothing on port */ }
    await new Promise(r => setTimeout(r, 2000))

    // Ensure corepack
    try {
      require('child_process').execSync('corepack enable 2>/dev/null || sudo corepack enable 2>/dev/null || true', {
        env: this.env, stdio: 'ignore',
      })
    } catch { /* best-effort */ }

    const bundlerLog = path.join(os.tmpdir(), 'metamask-bundler.log')
    log('Starting Metro bundler...')
    const logFd = require('fs').openSync(bundlerLog, 'w')
    const bundler = spawn('yarn', ['watch:clean'], {
      cwd: REPO_DIR,
      env: { ...this.env, METAMASK_ENVIRONMENT: 'dev', METAMASK_BUILD_TYPE: 'main' },
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    this.bundlerPid = bundler.pid ?? null
    bundler.unref()
    this.monitorBundler()

    // Wait for bundler ready — show tail of log so user sees progress
    const ready = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const poll = () => {
        try {
          require('child_process').execSync('curl -sf http://localhost:8081/status > /dev/null', { env: this.env, stdio: 'ignore' })
          resolve(true)
        } catch {
          const elapsed = Math.round((Date.now() - start) / 1000)
          try {
            const lastLine = require('child_process')
              .execSync(`tail -1 "${bundlerLog}"`, { encoding: 'utf8', env: this.env }).trim()
            if (lastLine) log(`Bundler (${elapsed}s): ${lastLine}`)
            else log(`Waiting for bundler... ${elapsed}s`)
          } catch { log(`Waiting for bundler... ${elapsed}s`) }

          if (Date.now() - start < 120000) setTimeout(poll, 3000)
          else resolve(false)
        }
      }
      setTimeout(poll, 5000)
    })

    if (ready) {
      log('Bundler is ready ✓')
    } else {
      log('Bundler taking longer than expected — it may still be starting')
    }

    // Make sure Simulator is open
    await run('open', ['-a', 'Simulator'])
    await new Promise(r => setTimeout(r, 1500))

    // Boot a simulator if none is running
    const bootStatus = this.bootSimulator(log)
    if (!bootStatus.ok) return bootStatus

    // Check if MetaMask is installed — if not, reinstall from cached build
    const isInstalled = (() => {
      try {
        require('child_process').execSync(
          'xcrun simctl get_app_container booted io.metamask.MetaMask',
          { env: this.env, stdio: 'ignore' }
        )
        return true
      } catch { return false }
    })()

    if (!isInstalled) {
      log('MetaMask not found in Simulator — reinstalling from cached build...')
      const appPath = this.findValidCachedApp(log)

      if (appPath) {
        log(`Reinstalling ${path.basename(appPath)}...`)
        await runWithLog('xcrun', ['simctl', 'install', 'booted', appPath], log, { env: this.env })
        log('MetaMask reinstalled ✓')
      } else {
        // No cache — download fresh from Runway automatically, same as launch()
        log('No cached build found — downloading from Runway...')
        const buildResult = await this.downloadBuild()
        if (!buildResult.ok) return buildResult
      }
    }

    // Relaunch MetaMask with deep link
    const bundlerUrl = encodeURIComponent('http://localhost:8081')
    await runShell(`xcrun simctl launch booted io.metamask.MetaMask 2>/dev/null || true`, log, undefined, this.env)
    await new Promise(r => setTimeout(r, 2000))
    await runShell(
      `xcrun simctl openurl booted "expo-metamask://expo-development-client/?url=${bundlerUrl}" 2>/dev/null || true`,
      log, undefined, this.env
    )

    log('MetaMask launched ✓')
    return { ok: true }
  }

  private toggleAppearance(mode: string): { ok: boolean; error?: string } {
    const appearance = mode === 'light' ? 'light' : 'dark'
    try {
      // Try "booted" first — works when a simulator is running
      require('child_process').execSync(
        `xcrun simctl ui booted appearance ${appearance}`,
        { env: this.env, stdio: 'pipe' }
      )
      return { ok: true }
    } catch {
      // Fallback: find any booted device UDID and target it directly
      try {
        const output = require('child_process').execSync(
          `xcrun simctl list devices booted -j`,
          { encoding: 'utf8', env: this.env }
        )
        const devices = JSON.parse(output).devices as Record<string, any[]>
        const booted = Object.values(devices).flat().find((d: any) => d.state === 'Booted')
        if (!booted) return { ok: false, error: 'No simulator is running. Launch MetaMask first.' }
        require('child_process').execSync(
          `xcrun simctl ui ${booted.udid} appearance ${appearance}`,
          { env: this.env, stdio: 'pipe' }
        )
        return { ok: true }
      } catch (e: unknown) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  /** Returns path to a valid cached .app bundle, or undefined if none is usable.
   *  Validates by reading CFBundleIdentifier — catches the "Missing bundle ID" case
   *  where the cached .app has a corrupted or incomplete Info.plist. */
  private findValidCachedApp(log: (msg: string) => void): string | undefined {
    const appDir = path.join(os.tmpdir(), 'metamask-sim-app')
    const renamedPath = path.join(os.tmpdir(), 'MetaMask.app')
    const candidates: string[] = []

    if (fs.existsSync(appDir)) {
      try {
        const found = require('child_process')
          .execSync(`find "${appDir}" -name "*.app" -maxdepth 3`, { encoding: 'utf8', env: this.env })
          .split('\n').filter(Boolean)
        candidates.push(...found)
      } catch { /* ignore */ }
    }
    if (fs.existsSync(renamedPath)) candidates.push(renamedPath)

    for (const candidate of candidates) {
      const bundleId = this.readBundleId(candidate)
      if (bundleId) return candidate
      log(`Cached build at ${path.basename(candidate)} is invalid (no bundle ID) — ignoring`)
      // Remove corrupt cache so next install doesn't hit the same error
      try { fs.rmSync(candidate, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    return undefined
  }

  /** Read CFBundleIdentifier from an iOS .app bundle. Returns null if missing/invalid. */
  private readBundleId(appPath: string): string | null {
    const plistPath = path.join(appPath, 'Info.plist')
    if (!fs.existsSync(plistPath)) return null
    try {
      const out = require('child_process')
        .execSync(`plutil -extract CFBundleIdentifier raw "${plistPath}" 2>/dev/null`, { encoding: 'utf8', env: this.env })
        .trim()
      return out || null
    } catch { return null }
  }

  private async reloadJs(): Promise<{ ok: boolean; error?: string }> {
    try {
      require('child_process').execSync(
        'curl -sf http://localhost:8081/reload',
        { env: this.env, stdio: 'ignore', timeout: 5000 }
      )
      return { ok: true }
    } catch {
      return { ok: false, error: 'Metro bundler is not responding on port 8081' }
    }
  }

  private monitorBundler() {
    if (!this.bundlerPid) return
    const pid = this.bundlerPid
    this._bundlerMonitor = setInterval(() => {
      try {
        process.kill(pid, 0)
      } catch {
        clearInterval(this._bundlerMonitor!)
        this._bundlerMonitor = null
        this.bundlerPid = null
        this.emit('setup:bundler-crashed', 'Metro bundler stopped unexpectedly')
      }
    }, 5000)
  }

  private _bundlerMonitor: ReturnType<typeof setInterval> | null = null

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
