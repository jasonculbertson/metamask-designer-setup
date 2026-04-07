#!/usr/bin/env bash
# Remove artifacts created by MetaMask Designer Setup so you can test a first-run flow.
# Does NOT uninstall Homebrew, Node, Yarn, Watchman, or Git (shared dev tools).

set -euo pipefail

echo "== MetaMask Designer Setup — reset local test state =="
echo ""

# 1) App state (wizard progress, installed build id, Infura key reference in JSON)
if [[ -f "$HOME/.metamask-designer-setup.json" ]]; then
  rm -f "$HOME/.metamask-designer-setup.json"
  echo "Removed ~/.metamask-designer-setup.json"
else
  echo "No ~/.metamask-designer-setup.json"
fi

# 2) Cloned repo + deps (large)
if [[ -d "$HOME/metamask-mobile" ]]; then
  rm -rf "$HOME/metamask-mobile"
  echo "Removed ~/metamask-mobile"
else
  echo "No ~/metamask-mobile"
fi

# 3) Refine AI (installed by the wizard into ~/Applications)
if [[ -d "$HOME/Applications/Refine AI.app" ]]; then
  rm -rf "$HOME/Applications/Refine AI.app"
  echo "Removed ~/Applications/Refine AI.app"
else
  echo "No ~/Applications/Refine AI.app"
fi

# Optional: if you ever installed Refine AI to /Applications via the DMG manually, uncomment:
# rm -rf "/Applications/Refine AI.app"

# 4) Temp artifacts from setup-runner.ts
rm -f "${TMPDIR:-/tmp}/metamask-bundler.log" 2>/dev/null || true
rm -rf "${TMPDIR:-/tmp}/metamask-sim-app" 2>/dev/null || true
rm -rf "${TMPDIR:-/tmp}/MetaMask.app" 2>/dev/null || true
# Refine DMG downloads
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'Refine.AI*.dmg' -delete 2>/dev/null || true
echo "Cleaned known files under TMPDIR (${TMPDIR:-/tmp})"
echo "   (If you still see a large *.app.zip in /tmp from Runway, delete it manually.)"

# 5) Electron user data (Runway window partition, caches)
for path in \
  "$HOME/Library/Application Support/MetaMask Designer Setup" \
  "$HOME/Library/Application Support/metamask-designer-setup" \
  "$HOME/Library/Caches/MetaMask Designer Setup" \
  "$HOME/Library/Caches/metamask-designer-setup" \
  "$HOME/Library/Logs/MetaMask Designer Setup"
do
  if [[ -e "$path" ]]; then
    rm -rf "$path"
    echo "Removed: $path"
  fi
done

# 6) iOS Simulator: remove installed MetaMask (bundle id from setup flow)
if xcrun simctl list devices booted 2>/dev/null | grep -q Booted; then
  if xcrun simctl uninstall booted io.metamask.MetaMask 2>/dev/null; then
    echo "Uninstalled io.metamask.MetaMask from the booted simulator"
  else
    echo "Could not uninstall MetaMask from simulator (app may not be installed)"
  fi
else
  echo "No booted simulator — skipped simctl uninstall."
  echo "   After you boot Simulator, run: xcrun simctl uninstall booted io.metamask.MetaMask"
fi

echo ""
echo "Done."
echo ""
echo "Not removed (on purpose): Xcode, Homebrew, Node, Yarn, Watchman, Git."
echo "If Metro is still running from a previous session, quit it or: pkill -f 'metro|watch:clean' (may affect other projects)."
