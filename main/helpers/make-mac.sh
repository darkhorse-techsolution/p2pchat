#!/bin/sh
# Builds the macOS input helper (universal arm64 + x86_64) next to its source. Needs the Xcode
# Command Line Tools (swiftc, lipo, codesign). The output is gitignored; electron-builder ships it
# in app.asar.unpacked/main/helpers. Signed with the local identity when it exists, ad-hoc otherwise.
set -e
cd "$(dirname "$0")"
OUT=p2pchat-input; T=$(mktemp -d)
xcrun swiftc -O -target arm64-apple-macos11.0 -o "$T/arm64" input-mac.swift
xcrun swiftc -O -target x86_64-apple-macos11.0 -o "$T/x64" input-mac.swift
lipo -create -output "$OUT" "$T/arm64" "$T/x64"; rm -rf "$T"
ID=${P2P_MAC_IDENTITY:-P2P Chat Local Signing}
if [ "$ID" != "-" ] && security find-identity -v -p codesigning 2>/dev/null | grep -q "$ID"; then
  codesign --force --sign "$ID" --options runtime --timestamp=none "$OUT"
else
  codesign --force --sign - "$OUT"
fi
echo "built $OUT ($(lipo -archs "$OUT")), signed by: $(codesign -dv --verbose=2 "$OUT" 2>&1 | grep '^Authority=' | head -1 | cut -d= -f2)"
