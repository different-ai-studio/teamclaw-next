#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="$ROOT_DIR/apps/ios"
DERIVED_DATA_PATH="$IOS_DIR/build"
APP_PATH="$DERIVED_DATA_PATH/Build/Products/Debug-iphonesimulator/AMUX.app"
SCHEME="${IOS_SCHEME:-AMUX}"
DESTINATION="${IOS_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}"
BUNDLE_ID="${IOS_BUNDLE_ID:-tech.teamclaw.mobile}"

cd "$ROOT_DIR"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

if ! xcrun simctl list devices booted | grep -q "(Booted)"; then
  echo "No booted iOS Simulator found. Boot one from Simulator.app first." >&2
  exit 1
fi

(
  cd "$IOS_DIR"
  xcodegen generate
)

xcodebuild \
  -project "$IOS_DIR/AMUX.xcodeproj" \
  -scheme "$SCHEME" \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA_PATH" \
  build

xcrun simctl install booted "$APP_PATH"
xcrun simctl launch booted "$BUNDLE_ID"
