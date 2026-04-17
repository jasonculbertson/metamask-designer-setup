# MetaMask Designer Setup

One-click app for designers to run **MetaMask Mobile** in the iOS Simulator — no Terminal required. Sets up all tooling, clones the repo, installs dependencies, downloads the latest Runway build, starts the Metro bundler, and launches Refine AI.

## Download

**[Download v1.0.3 (Apple Silicon)](https://github.com/jasonculbertson/metamask-designer-setup/releases/download/v1.0.3/MetaMask.Designer.Setup-1.0.3-arm64.dmg)**

Requires an Apple Silicon Mac (M1/M2/M3 or later) running macOS.

---

## What's in v1.0.3

- **PR switcher** — search open PRs by title, author, or label and switch with one click (runs `git checkout` + `yarn install` automatically)
- **Team filters** — filter PRs by team (Design System, UX, Design, Tokens)
- **Open in GitHub** — jump from any PR preview directly to the PR in your browser
- **Dark / Light mode toggle** — switch the iOS Simulator appearance without leaving the app
- **Reload JS** — fast-reload the bundle without restarting Metro
- **Metro crash detection** — alerts you if the bundler crashes with a one-click restart
- **Auto-update** — checks for new versions on every launch and installs them in the background
- **Fixed: PR switch failing** — stashes local changes before checkout so git never blocks a branch switch

---

## Before you run it

### Required: Xcode

Install **[Xcode](https://apps.apple.com/app/xcode/id497799835)** from the Mac App Store (the full app, not just Command Line Tools).

- Place it at `/Applications/Xcode.app` (default location)
- Open Xcode once and accept the license agreement
- In **Xcode → Settings → Platforms**, download at least one **iOS Simulator** runtime (iPhone 15 or iPhone 16 recommended)

### Required: Infura API Key

The app will ask for an Infura project ID to configure the MetaMask environment. Get a free key at [app.infura.io](https://app.infura.io).

### Required: Administrator access

The setup step installs Homebrew, Node, Yarn, and Watchman. Your Mac account needs administrator privileges.

### Optional: Refine AI

The app installs **Refine AI** automatically for design review and screenshot tooling.

---

## How it works

**First run (~20 minutes)**
1. Checks Xcode and Homebrew
2. Asks for your Infura key
3. Installs Node 20, Yarn, Watchman, Git
4. Clones `MetaMask/metamask-mobile` into `~/metamask-mobile`
5. Runs `yarn install` and `yarn setup:expo`
6. Downloads the latest Runway build and installs it in the Simulator
7. Starts Metro and launches MetaMask

**Returning runs (seconds)**
- Opens straight to a PR picker — choose a PR to test or just hit Launch to reuse the current setup

---

## Running from source

```bash
npm install
npm start        # tsc + electron
npm run dist     # build notarized DMG (requires Apple Developer credentials)
```

---

## Troubleshooting

- **"Xcode not found"** — Make sure Xcode is at `/Applications/Xcode.app`, open it once, and accept the license.
- **Simulator issues** — Open Simulator from Xcode manually at least once and confirm an iPhone runtime is installed under Xcode → Settings → Platforms.
- **Metro bundler errors** — Use the "Restart Server" button in the app, or check `~/Library/Logs/metamask-bundler.log` for details.

For issues with the `metamask-mobile` repo itself, refer to MetaMask's own documentation.
