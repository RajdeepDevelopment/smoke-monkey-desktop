#!/usr/bin/env bash
# Assemble a macOS .app bundle from the release binary + generated icons.
# Required because `tauri build` bundling needs full Xcode, but the .app
# structure itself can be produced from the Command Line Tools alone.
# Usage: scripts/bundle-app.sh   (run from apps/desktop)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIN="$ROOT/apps/desktop/src-tauri/target/release/smoke-monkey-desktop"
ICNS="$ROOT/apps/desktop/src-tauri/icons/icon.icns"
APP_NAME="Smoke Monkey.app"
DEST="$ROOT/apps/desktop/src-tauri/target/release/$APP_NAME"

if [ ! -x "$BIN" ]; then
  echo "release binary missing — run: pnpm exec tauri build --no-bundle" >&2
  exit 1
fi
if [ ! -f "$ICNS" ]; then
  echo "icon.icns missing — run: pnpm exec tauri icon assets/icon-source.png" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/Contents/MacOS" "$DEST/Contents/Resources"

cp "$BIN" "$DEST/Contents/MacOS/smoke-monkey-desktop"
cp "$ICNS" "$DEST/Contents/Resources/icon.icns"

cat > "$DEST/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>smoke-monkey-desktop</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundleIdentifier</key>
  <string>com.smokemonkey.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Smoke Monkey</string>
  <key>CFBundleDisplayName</key>
  <string>Smoke Monkey</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$DEST" 2>/dev/null || true

echo "built $DEST"
