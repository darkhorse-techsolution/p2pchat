#!/bin/sh
# Runs the headless suites under ELECTRON's runtime (BoringSSL), which is the one that matters.
# A pass under system Node proves nothing: that is how chacha20-poly1305 got through once.
cd "$(dirname "$0")/.." || exit 1
ELECTRON="/Users/max/Public/shield-wrap/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -x "$ELECTRON" ] || { echo "Electron not found at $ELECTRON" >&2; exit 1; }
export ELECTRON_RUN_AS_NODE=1
echo "== crypto";  "$ELECTRON" test/crypto-test.js || exit 1
echo "== engine";  "$ELECTRON" test/engine-test.js || exit 1
echo "== relay";   "$ELECTRON" test/relay-test.js || exit 1
echo "== relay+engine"; "$ELECTRON" test/relay-engine-test.js || exit 1
echo "== control"; "$ELECTRON" test/control-test.js || exit 1
echo "== theme contrast"; node test/theme-contrast.js | tail -1 || exit 1
echo
echo "UI flow: start two instances with --remote-debugging-port=9411 / 9412 and fresh --instance names, then run test/ui/flow.sh"
echo "Screenshot flow: two fresh instances on 9421 / 9422 (see the header of test/ui/shot.sh), then run test/ui/shot.sh"
