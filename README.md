# MetaMask Designer Setup

Electron app that walks designers through a one-click setup for **MetaMask Mobile** on the **iOS Simulator**: tooling, repo clone, dependencies, Runway build install, Metro bundler, and Refine AI.

## Requirements (before you run it)

### macOS

- **Apple Silicon (M1/M2/M3 or later)** — release builds are distributed as **arm64** only (`dmg` target in this repo). Intel Macs are not supported for the packaged app unless you build from source and adjust the Electron builder config.

### Xcode (required)

The app checks that the full Xcode app is installed and selected:

- Install **[Xcode](https://apps.apple.com/app/xcode/id497799835)** from the Mac App Store (not only Command Line Tools).
- Put it at **`/Applications/Xcode.app`** (default location).
- Open Xcode **once** and accept the license; let it install **additional components** if prompted.
- In **Settings → Locations**, ensure **Command Line Tools** points to your Xcode version.

The setup flow uses **Simulator** and **`xcrun simctl`** (boot device, install `.app`, launch). Install at least one **iOS Simulator** runtime in Xcode (**Settings → Platforms** or **Xcode → Settings → Components**) so a device such as **iPhone 15** or **iPhone 16** is available.

### Administrator access

The automated **Homebrew** install step may prompt for your **macOS administrator password**. Your user account should be allowed to administer the computer (the app checks this before installing prerequisites).

### Network and accounts

- **Internet** — clones `MetaMask/metamask-mobile`, downloads Runway builds, and may fetch Refine AI updates.
- **Infura project ID** — you will paste this into the app so local env files can be configured (get a key from [Infura](https://infura.io/) if you do not have one).

### Optional: Refine AI

The launcher can install or update **Refine AI** into `~/Applications` for the full workflow. If you skip it, the rest of the setup can still proceed depending on how you use the app.

---

## Running from source (developers)

1. Install **Node.js 20+** and **npm** (e.g. from [nodejs.org](https://nodejs.org/) or Homebrew).
2. Install **Xcode** as above (needed to exercise simulator steps locally).
3. In the repo root:

   ```bash
   npm install
   npm start
   ```

   This runs `tsc` and starts Electron.

4. To produce a macOS `.dmg` (local build):

   ```bash
   npm run dist
   ```

   Release builds that are **notarized** for distribution need Apple Developer credentials and environment variables configured for `electron-builder`; that is only required for maintainers shipping signed builds.

---

## What gets installed automatically

When you step through the app (after Xcode is in place), it can install or use:

- **Homebrew** (if missing)
- **Node 20**, **Yarn** (via Corepack), **Watchman**, **Git** (as needed)
- A clone of **`~/metamask-mobile`** and `yarn` / Expo setup scripts defined by that repo

Disk space and time for the first run can be significant (clone + `yarn install` + `yarn setup:expo`).

---

## Troubleshooting

- **“Xcode not found”** — Install Xcode from the App Store, open it once, and confirm `xcode-select -p` points at Xcode’s developer directory and `/Applications/Xcode.app` exists.
- **Simulator issues** — Open **Simulator** manually from Xcode once; ensure an iPhone simulator is downloaded in Xcode’s platform settings.

For problems with the **metamask-mobile** repo itself (Metro, native build errors), use MetaMask’s own documentation and issues.
