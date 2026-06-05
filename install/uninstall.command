#!/usr/bin/env bash
set -euo pipefail

APP_NAME="SlabScannerHelper"
DEST_DIR="$HOME/Library/Application Support/$APP_NAME"
PLIST="$HOME/Library/LaunchAgents/com.triumph.slabscanner.helper.plist"
LOG_DIR="$HOME/Library/Logs/$APP_NAME"

echo ""
echo "▶ Uninstalling $APP_NAME..."
echo ""

# Stop the LaunchAgent
if launchctl print "gui/$(id -u)/com.triumph.slabscanner.helper" &>/dev/null; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    echo "  ✓ LaunchAgent stopped"
else
    echo "  (LaunchAgent was not running)"
fi

# Remove plist
if [ -f "$PLIST" ]; then
    rm "$PLIST"
    echo "  ✓ Removed plist"
fi

# Remove binary
if [ -d "$DEST_DIR" ]; then
    rm -rf "$DEST_DIR"
    echo "  ✓ Removed binary"
fi

# Remove logs
if [ -d "$LOG_DIR" ]; then
    rm -rf "$LOG_DIR"
    echo "  ✓ Removed logs"
fi

echo ""
echo "✓ $APP_NAME uninstalled."
echo ""
