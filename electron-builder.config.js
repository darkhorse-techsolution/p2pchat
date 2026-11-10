'use strict';
// Packaging for macOS, Windows and Linux from one host. No code signing: there
// is no Apple Developer ID or Windows certificate, so builds are unsigned and
// users get the usual first-launch warnings (documented in README).
const path = require('node:path');
// P2P_VARIANT=monitor builds the Windows installer without capture blocking (npm run dist:win:monitor):
// same app, the flag lands in the packaged package.json and main/main.js reads it.
const VARIANT = process.env.P2P_VARIANT || '';

module.exports = {
  appId: 'io.p2pchat.desktop',
  productName: 'P2P Chat',
  copyright: 'AGPL-3.0',
  electronVersion: '45.1.0',
  // Reuse an already-downloaded Electron for the native build when told to
  // (P2P_ELECTRON_DIST=/path/to/electron/dist); other targets download theirs.
  electronDist: process.env.P2P_ELECTRON_DIST || undefined,
  asar: true,
  npmRebuild: false,
  // Lock the shipped binary down: no ELECTRON_RUN_AS_NODE / NODE_OPTIONS / --inspect
  // hijacking, asar integrity checked, app loaded only from the asar.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: false,   // nothing to protect (no cookies), and ON makes the network helper hit the Keychain with its own ad-hoc hash -> macOS prompt on every launch
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: true,
    resetAdHocDarwinSignature: true,
  },
  directories: { buildResources: 'build', output: VARIANT ? `dist/${VARIANT}` : 'dist' },
  ...(VARIANT ? { extraMetadata: { p2pVariant: VARIANT } } : {}),
  files: ['main/**', 'core/**', 'ui/**', 'package.json', '!**/*.md', '!**/*.swift', '!main/helpers/make-mac.sh', '!test/**', '!relay/**', '!build/**', '!dist/**'],
  asarUnpack: ['main/helpers/**'],   // the remote-control helpers are run as separate processes, so they must exist as real files
  publish: null,

  mac: {
    category: 'public.app-category.social-networking',
    target: ['dmg', 'zip'],     // arch comes from the CLI (--arm64 / --x64) so electronDist can differ per arch
    // A self-signed "P2P Chat Local Signing" certificate on this Mac (keychain
    // ~/Library/Keychains/p2pchat-sign.keychain-db, see README "Building"). Not an Apple
    // Developer ID, so other Macs still see the "unverified developer" dialog and use Open
    // Anyway; but unlike an ad-hoc signature ("-") the identity is the same for every
    // build, so macOS keeps the Keychain grant and the Screen Recording / microphone
    // permissions across updates instead of treating each build as a new app.
    // Fall back to ad-hoc with P2P_MAC_IDENTITY=- (still required on Apple Silicon).
    identity: process.env.P2P_MAC_IDENTITY || 'P2P Chat Local Signing',
    notarize: false,
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',          // adds the microphone entitlement for screen-share voice
    entitlementsInherit: 'build/entitlements.mac.plist',
    gatekeeperAssess: false,
    darkModeSupport: true,
    extendInfo: {
      LSUIElement: true,                       // no Dock icon from the first frame, not only after app.dock.hide()
      NSHumanReadableCopyright: 'AGPL-3.0',
      NSMicrophoneUsageDescription: 'Your voice is sent to the contact while you share your screen.',
    },
  },
  dmg: { sign: false, contents: [{ x: 130, y: 220 }, { x: 410, y: 220, type: 'link', path: '/Applications' }] },

  win: {
    target: ['nsis'],           // no portable build: it unpacks to a random TEMP dir, which breaks autostart and the tray identity
    signExecutable: false,      // keep icon + version metadata on the exe, skip signing (no certificate)
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    oneClick: true,             // per-user, no UAC prompt, stable exe path under %LOCALAPPDATA%\Programs
    perMachine: false,
    allowElevation: true,
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    ...(VARIANT === 'monitor' ? { artifactName: 'P2P Chat Monitor Setup ${version}.${ext}' } : {}),
    include: 'build/installer.nsh',   // removes the autostart Run key on uninstall
  },

  linux: {
    target: ['deb', 'AppImage'],   // deb first: keeps the Chromium sandbox on via its AppArmor profile; AppImage runs with --no-sandbox
    category: 'Network;InstantMessaging',
    maintainer: 'P2P Chat <p2pchat@localhost>',
    synopsis: 'Peer-to-peer end-to-end encrypted chat',
    description: 'Peer-to-peer, end-to-end encrypted chat with no user identifiers. History lives in an encrypted vault on your device and syncs device to device.',
    syncDesktopName: true,         // installs io.p2pchat.P2PChat.desktop, matching app.setDesktopName
  },
  deb: { depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'python3'] },   // python3 + libxtst6: the remote-control helper
};
