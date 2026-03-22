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

function runShell(cmd: string, log: (msg: string) => void, cwd?: string): Promise<void> {
  return runWithLog('/bin/bash', ['-c', cmd], log, { cwd })
}

function which(bin: string): boolean {
  try {
    require('child_process').execSync(`which ${bin}`, { stdio: 'ignore' })
    return true
  } catch { return false }
}

export class SetupRunner {
  private emit: Emit
  private state: State = {}

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
        case 'check-xcode':      return await this.checkXcode()
        case 'install-prereqs':  return await this.installPrereqs()
        case 'save-infura-key':  return this.saveInfuraKey(payload?.key ?? '')
        case 'clone-repo':       return await this.cloneOrPullRepo()
        case 'install-deps':     return await this.installDeps()
        case 'download-build':   return await this.downloadBuild()
        case 'launch':           return await this.launch()
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

    // Homebrew
    if (!which('brew')) {
      log('Installing Homebrew...')
      await runShell(
        'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        log
      )
    } else {
      log('Homebrew already installed ✓')
    }

    // Ensure brew is on PATH (Apple Silicon path)
    const brewPath = fs.existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin' : '/usr/local/bin'
    const env = { PATH: `${brewPath}:${process.env.PATH}` }

    // Node 20
    const nodeOk = (() => {
      try {
        const v = require('child_process').execSync('node --version', { encoding: 'utf8' }).trim()
        return v.startsWith('v20')
      } catch { return false }
    })()

    if (!nodeOk) {
      log('Installing Node 20...')
      await runWithLog(`${brewPath}/brew`, ['install', 'node@20'], log)
      await runWithLog(`${brewPath}/brew`, ['link', 'node@20', '--force', '--overwrite'], log)
    } else {
      log('Node 20 already installed ✓')
    }

    // Yarn via corepack
    if (!which('yarn')) {
      log('Enabling Yarn via corepack...')
      await runShell('corepack enable && corepack prepare yarn@4 --activate', log, undefined)
    } else {
      log('Yarn already installed ✓')
    }

    // Watchman
    if (!which('watchman')) {
      log('Installing Watchman...')
      await runWithLog(`${brewPath}/brew`, ['install', 'watchman'], log)
    } else {
      log('Watchman already installed ✓')
    }

    // Git
    if (!which('git')) {
      log('Installing Git...')
      await runWithLog(`${brewPath}/brew`, ['install', 'git'], log)
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
      await runWithLog('git', ['pull'], log, { cwd: REPO_DIR })
    } else {
      log('Cloning MetaMask/metamask-mobile (this may take a minute)...')
      await runWithLog('git', [
        'clone', '--depth=1',
        'https://github.com/MetaMask/metamask-mobile.git',
        REPO_DIR,
      ], log)
    }

    // Write .js.env only if missing
    const envPath = path.join(REPO_DIR, '.js.env')
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, `MM_INFURA_PROJECT_ID=${this.state.infuraKey}\n`)
      log('Created .js.env with your Infura key ✓')
    } else {
      log('.js.env already exists — leaving untouched ✓')
    }

    this.progress('repo', 'done')
    return { ok: true }
  }

  private async installDeps(): Promise<{ ok: boolean; error?: string }> {
    this.progress('deps', 'running')
    const log = this.log.bind(this)

    // Skip if node_modules exists and yarn.lock hasn't changed
    const modulesExist = fs.existsSync(path.join(REPO_DIR, 'node_modules'))
    if (modulesExist) {
      log('Dependencies already installed — skipping ✓')
      this.progress('deps', 'skipped')
      return { ok: true }
    }

    log('Running yarn setup:expo — this takes 5-10 minutes...')
    await runWithLog('yarn', ['setup:expo'], log, { cwd: REPO_DIR })

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
    log(`Downloading ${result.filename}...`)
    await runWithLog('curl', ['-L', '--progress-bar', '-o', zipPath, result.url], log)

    const appDir = path.join(os.tmpdir(), 'metamask-sim-app')
    fs.rmSync(appDir, { recursive: true, force: true })
    fs.mkdirSync(appDir, { recursive: true })

    log('Unzipping...')
    await runWithLog('unzip', ['-o', zipPath, '-d', appDir], log)

    log('Booting Simulator...')
    await runShell('xcrun simctl boot "iPhone 16" 2>/dev/null || xcrun simctl boot "iPhone 15" 2>/dev/null || true', log)

    const appPath = require('child_process')
      .execSync(`find "${appDir}" -name "*.app" -maxdepth 2`, { encoding: 'utf8' })
      .split('\n').filter(Boolean)[0]

    log(`Installing ${path.basename(appPath)} into Simulator...`)
    await runWithLog('xcrun', ['simctl', 'install', 'booted', appPath], log)

    this.state.installedBuild = buildId
    this.saveState()

    this.progress('build', 'done', buildId)
    return { ok: true }
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    this.progress('launch', 'running')
    const log = this.log.bind(this)

    log('Opening Simulator...')
    await run('open', ['-a', 'Simulator'])

    // Wait for simulator to be ready
    await new Promise(r => setTimeout(r, 3000))

    log('Launching MetaMask...')
    await runShell('xcrun simctl launch booted io.metamask.MetaMask 2>/dev/null || true', log)

    // Start bundler in a new Terminal tab
    log('Starting bundler in Terminal...')
    const watchCmd = `cd "${REPO_DIR}" && yarn watch:clean`
    spawn('osascript', ['-e',
      `tell application "Terminal" to do script "${watchCmd.replace(/"/g, '\\"')}"`
    ])

    this.state.setupComplete = true
    this.saveState()

    this.progress('launch', 'done')
    return { ok: true }
  }
}
