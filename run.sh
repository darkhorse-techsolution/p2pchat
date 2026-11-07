#!/bin/sh
# ELECTRON_RUN_AS_NODE is set in this shell's environment; with it set, the
# Electron binary runs as a bare Node and no window ever appears.
unset ELECTRON_RUN_AS_NODE
ELECTRON="/Users/max/Public/shield-wrap/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "Electron not found at $ELECTRON" >&2; exit 1; }
exec "$ELECTRON" "$(cd "$(dirname "$0")" && pwd)" "$@"
