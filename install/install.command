#!/usr/bin/env bash
set -euo pipefail

APP_NAME="SlabScannerHelper"
DEST_DIR="$HOME/Library/Application Support/$APP_NAME"
PLIST="$HOME/Library/LaunchAgents/com.triumph.slabscanner.helper.plist"
LOG_DIR="$HOME/Library/Logs/$APP_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/../helper" && pwd)"

echo ""
echo "▶ Installing $APP_NAME..."
echo ""

mkdir -p "$DEST_DIR" "$LOG_DIR"

# ── Build the helper binary ──────────────────────────────────────────────
# Check for pre-built binary first
if [ -f "$SCRIPT_DIR/slabscanner-helper" ]; then
    echo "  Using pre-built binary..."
    cp "$SCRIPT_DIR/slabscanner-helper" "$DEST_DIR/slabscanner-helper"
elif command -v swift &>/dev/null; then
    echo "  Building from source (requires Swift toolchain)..."
    cd "$HELPER_DIR"
    swift build -c release --quiet 2>&1 | sed 's/^/  /'
    cp "$(swift build -c release --show-bin-path)/SlabScannerHelper" "$DEST_DIR/slabscanner-helper"
    cd "$SCRIPT_DIR"
else
    echo "  ✗ No pre-built binary and Swift not available."
    echo "    Install Xcode Command Line Tools: xcode-select --install"
    exit 1
fi

chmod +x "$DEST_DIR/slabscanner-helper"
xattr -dr com.apple.quarantine "$DEST_DIR/slabscanner-helper" 2>/dev/null || true

echo "  ✓ Binary installed to $DEST_DIR/"

# ── Determine allowed origin ────────────────────────────────────────────
# Default: allow file:// and localhost. Override with env var.
ALLOWED_ORIGIN="${SLABSCANNER_ALLOWED_ORIGIN:-}"
if [ -z "$ALLOWED_ORIGIN" ]; then
    echo ""
    echo "  No SLABSCANNER_ALLOWED_ORIGIN set."
    echo "  Helper will accept connections from localhost and file:// origins."
    echo "  To restrict to a specific domain, set the env var before running."
fi

# ── Write LaunchAgent plist ─────────────────────────────────────────────
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.triumph.slabscanner.helper</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DEST_DIR/slabscanner-helper</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/helper.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/helper.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SLABSCANNER_ALLOWED_ORIGIN</key>
    <string>${ALLOWED_ORIGIN}</string>
  </dict>
</dict>
</plist>
PLISTEOF

echo "  ✓ LaunchAgent plist written"

# ── Load the LaunchAgent ────────────────────────────────────────────────
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "  ✓ LaunchAgent loaded (starts on login, auto-restarts)"

# ── Verify ──────────────────────────────────────────────────────────────
echo ""
sleep 1
if launchctl print "gui/$(id -u)/com.triumph.slabscanner.helper" &>/dev/null; then
    echo "✓ $APP_NAME is running!"
    echo ""
    echo "  WebSocket: ws://127.0.0.1:7878"
    echo "  Logs:      $LOG_DIR/helper.log"
    echo ""
    echo "  Open the Slab Scanner web app — the helper status should show green."
else
    echo "⚠ $APP_NAME may not have started. Check logs:"
    echo "  cat $LOG_DIR/helper.log"
fi

echo ""
