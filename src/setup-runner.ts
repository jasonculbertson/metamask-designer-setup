import { execSync, spawn } from 'child_process'
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

function exec(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: 'utf8', cwd: opts?.cwd }).trim()
}

function which(bin: string): boolean {
  try { exec(`which ${bin}`); return true } catch { return false }
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

  private log(msg: string) {
    this.emit('setup:log', msg)
  }

  private progress(step: string, status: 'running' | 'done' | 'skipped' | 'error', detail?: string) {
    this.emit('setup:progress', { step, status, detail })
  }

  getState(): State {
    return this.state
  }

  async runStep(stepId: string, payload?: Record<string, string>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    try {
      switch (stepId) {
        case 'check-xcode': return this.checkXcode()
        case 'install-prereqs': return this.installPrereqs()
        case 'save-infura-key': return this.saveInfuraKey(payload?.key ?? '')
        case 'clone-repo': return this.cloneOrPullRepo()
        case 'install-deps': return this.installDeps()
        case 'download-build': return this.downloadBuild()
        case 'launch': return this.launch()
        default: return { ok: false, error: `Unknown step: ${stepId}` }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      this.emit('setup:error', msg)
      return { ok: false, error: msg }
    }
  }

  private checkXcode(): { ok: boolean; error?: string } {
    this.progress('xcode', 'running')
    try {
      exec('xcode-select -p')
      const simPath = '/Applications/Xcode.app'
      if (!fs.existsSync(simPath)) {
        this.progress('xcode', 'error', 'Xcode not found')
        return { ok: false, error: 'xcode-missing' }
      }
      this.progress('xcode', 'done')
      return { ok: true }
    } catch {
      this.progress('xcode', 'error', 'Xcode not installed')
      return { ok: false, error: 'xcode-missing' }
    }
  }

  private async installPrereqs(): Promise<{ ok: boolean; error?: string }> {
    this.progress('prereqs', 'running')

    // Homebrew
    if (!which('brew')) {
      this.log('Installing Homebrew...')
      exec('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"')
    } else {
      this.log('Homebrew already installed')
    }

    // Node 20
    try {
      const nodeVer = exec('node --version')
      if (!nodeVer.startsWith('v20')) {
        this.log('Installing Node 20...')
        exec('brew install node@20')
        exec('brew link node@20 --force --overwrite')
      } else {
        this.log(`Node ${nodeVer} already installed`)
      }
    } catch {
      this.log('Installing Node 20...')
      exec('brew install node@20')
      exec('brew link node@20 --force --overwrite')
    }

    // Yarn 4
    if (!which('yarn')) {
      this.log('Installing Yarn...')
      exec('corepack enable && corepack prepare yarn@4 --activate')
    } else {
      this.log('Yarn already installed')
    }

    // Watchman
    if (!which('watchman')) {
      this.log('Installing Watchman...')
      exec('brew install watchman')
    } else {
      this.log('Watchman already installed')
    }

    // Git
    if (!which('git')) {
      this.log('Installing Git...')
      exec('brew install git')
    } else {
      this.log('Git already installed')
    }

    this.progress('prereqs', 'done')
    return { ok: true }
  }

  private saveInfuraKey(key: string): { ok: boolean; error?: string } {
    if (!key || key.trim().length < 10) {
      return { ok: false, error: 'Invalid API key' }
    }
    this.state.infuraKey = key.trim()
    this.saveState()
    this.progress('infura', 'done')
    return { ok: true }
  }

  private cloneOrPullRepo(): { ok: boolean; error?: string } {
    this.progress('repo', 'running')

    if (fs.existsSync(REPO_DIR)) {
      this.log('Pulling latest metamask-mobile...')
      exec('git pull', { cwd: REPO_DIR })
    } else {
      this.log('Cloning metamask-mobile...')
      exec(`git clone https://github.com/MetaMask/metamask-mobile.git "${REPO_DIR}"`)
    }

    // Write .js.env if missing or key changed
    const envPath = path.join(REPO_DIR, '.js.env')
    const envContent = `MM_INFURA_PROJECT_ID=${this.state.infuraKey}\n`
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, envContent)
      this.log('Created .js.env')
    } else {
      this.log('.js.env already exists — leaving untouched')
    }

    this.progress('repo', 'done')
    return { ok: true }
  }

  private installDeps(): { ok: boolean; error?: string } {
    this.progress('deps', 'running')
    this.log('Running yarn setup:expo (this takes a few minutes)...')
    exec('yarn setup:expo', { cwd: REPO_DIR })
    this.progress('deps', 'done')
    return { ok: true }
  }

  private async downloadBuild(): Promise<{ ok: boolean; error?: string; data?: unknown }> {
    this.progress('build', 'running')
    this.log('Checking latest Runway build...')

    const result = await getLatestRunwayBuildUrl(RUNWAY_BUCKET, this.log.bind(this))
    if (!result.url || !result.filename) {
      return { ok: false, error: 'Could not find build on Runway' }
    }

    const buildId = result.filename.replace('.app.zip', '')

    if (this.state.installedBuild === buildId) {
      this.log(`Build ${buildId} already installed — skipping download`)
      this.progress('build', 'skipped', buildId)
      return { ok: true, data: { skipped: true } }
    }

    const zipPath = path.join(os.tmpdir(), result.filename)
    this.log(`Downloading ${result.filename} (75 MB)...`)
    exec(`curl -L -o "${zipPath}" "${result.url}"`)

    this.log('Unzipping...')
    const appDir = path.join(os.tmpdir(), 'metamask-sim-app')
    fs.mkdirSync(appDir, { recursive: true })
    exec(`unzip -o "${zipPath}" -d "${appDir}"`)

    this.log('Installing into Simulator...')
    const appPath = exec(`find "${appDir}" -name "*.app" -maxdepth 2`).split('\n')[0]
    exec('xcrun simctl boot "iPhone 16" 2>/dev/null || true')
    exec(`xcrun simctl install booted "${appPath}"`)

    this.state.installedBuild = buildId
    this.saveState()

    this.progress('build', 'done', buildId)
    return { ok: true }
  }

  private launch(): { ok: boolean; error?: string } {
    this.progress('launch', 'running')

    // Open Simulator
    exec('open -a Simulator')

    // Launch MetaMask bundle id
    setTimeout(() => {
      try {
        exec('xcrun simctl launch booted io.metamask.MetaMask')
      } catch {
        // app may already be open
      }
    }, 2000)

    // Start bundler in new Terminal tab
    const watchCmd = `cd "${REPO_DIR}" && yarn watch:clean`
    spawn('osascript', [
      '-e', `tell application "Terminal"`,
      '-e', `do script "${watchCmd.replace(/"/g, '\\"')}"`,
      '-e', `end tell`,
    ])

    this.state.setupComplete = true
    this.saveState()
    this.progress('launch', 'done')
    return { ok: true }
  }
}
