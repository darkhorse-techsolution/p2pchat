# P2P Chat

Peer-to-peer, end-to-end encrypted chat with no user identifiers, persistent encrypted history that
reconciles device to device, code snippets with highlighting, and a window that screenshots and
screen recordings cannot capture. Runs in the background: on macOS no Dock icon and no menu-bar icon,
on Windows no taskbar button (a tray icon only). The global hotkey is the way in: **⌘⌥V** on macOS,
**Ctrl+Win+X** on Windows by default, changeable in Settings. Reaches contacts anywhere through your own
relay, which sees only random addresses and ciphertext; new installs come pre-set to it.

## Install

Builds are in `dist/` after `npm run dist` (see *Building*). They are **not code-signed** (no Apple
Developer ID, no Windows certificate), so every OS warns once. What users will see:

| OS | File | First launch |
|---|---|---|
| macOS (Apple Silicon) | `P2P Chat-<version>-arm64.dmg` | "Apple could not verify…". Open **System Settings → Privacy & Security**, scroll to the message about P2P Chat, click **Open Anyway**, then open it again. There is no Dock icon and no menu-bar icon by design: the window shows on first run and tells you the hotkey; afterwards **⌘⌥V** shows and hides it. If you ever lose it, opening the app again from Launchpad brings the window back. Quit from Settings. The 📷 and Share buttons need **Screen Recording** permission: the first click lists the app under System Settings → Privacy & Security → Screen & System Audio Recording; turn it on, quit and reopen the app. The first share also asks for the **microphone** (allow in the dialog). |
| macOS (Intel) | `P2P Chat-<version>.dmg` | Same. |
| Windows 10 (2004+) / 11 | `P2P Chat Setup <version>.exe` | SmartScreen: **More info → Run anyway**. Installs per user, no admin prompt. On first launch Windows Firewall asks to allow network access (for the local-network listener) - click **Allow**; it is not needed for relay chats but enables direct LAN connections. Tray icon may sit in the `^` overflow until pinned. **Ctrl+Win+X** shows/hides. A second installer, `P2P Chat Monitor Setup <version>.exe` (in `dist/monitor/`), is the **monitor** variant: the same app without capture blocking (see *Capture blocked*). |
| Ubuntu 22.04 / 24.04 | `p2pchat_<version>_amd64.deb` | `sudo apt install ./p2pchat_<version>_amd64.deb`. The window stays in the dock and closing it quits (see *Linux*). The AppImage is a fallback only: needs `libfuse2` (`libfuse2t64` on 24.04) and runs with the Chromium sandbox off. |

**Which builds were actually run.** The macOS arm64 build (0.2.1) was launched as a packaged app on
this Mac: fresh install creates the keychain-held vault without a prompt, the window appears, the
hotkey hides and shows it, and the window is absent from screen captures; 0.3.1 was installed into
/Applications and started on this Mac (Keychain prompt once, as expected for a new build). Each release
since (0.3.0, 0.3.1, 0.4.0) was installed per user on an Ubuntu 24.04 box and booted headless under
Xvfb (vault, window, hotkey registered, relay up) and installed silently in a Windows 11 VM (installer
exit 0, DPAPI-held vault, window, hotkey, relay up); 0.2.1 in the same VM also proved capture blocking
(window absent from a screenshot with blocking on, visible after a `--no-protection` relaunch). The
macOS x64 build has **not** been run (no Intel Mac here). Screenshots were exercised on macOS from
source; screen sharing from source on macOS and on the Linux box (Xvfb), across the internet between
the two. On Windows both rest on `desktopCapturer` and WebRTC being the same code there; the packaged
the packaged macOS 0.4.1 and 0.5.0 were installed into /Applications and run on this Mac (0.5.0 booted with the
vault key from the Keychain, the relay up and both hotkeys registered); Linux 0.5.0 was installed per user on the
Ubuntu box and restarted inside its RDP session; Windows 0.5.0 is built but has not been run. 0.6.0: the
macOS build was installed over 0.5.0 (it stops at the Keychain prompt described above until it is allowed),
the Linux build was restarted inside the box's RDP session (vault, window, hotkeys, relay up), and the Windows
installer was run on a Windows 11 VM: silent install exit 0, `P2P Chat.exe` 0.6.0.0, boot with the DPAPI vault,
window shown, hotkeys registered, relay up, the three remote-control helpers present under
`resources/app.asar.unpacked/main/helpers`, and the PowerShell helper compiled its SendInput shim and reported
`ready` when started by hand with an empty input. 0.6.1 (the session-tap change for the macOS helper) was installed on the Mac (booted with the vault from the
Keychain, relay up). 0.7.0: the Mac build was installed over 0.6.1 (boot, vault from the Keychain, both stored hotkeys
moved from the old defaults, the three hotkeys registered, relay up) and the Linux build was restarted inside the
box's RDP session (boot v0.7.0); the Windows 0.7.0 installer is built but has not been run. 0.7.1: the Mac build was
installed over 0.7.0 (its helper, run by hand from the installed bundle, reported `ready` and a cursor image) and the
Linux build was restarted inside the box's RDP session (boot v0.7.1, the three hotkeys registered, window shown, relay
up); the Windows 0.7.1 installer is built but has not been run.

## Reaching people outside your network

Two apps on the same LAN find each other directly. Everywhere else they go through the **relay**,
which every new install is pre-set to:

```
relay://49.12.170.6:4433/eEo_7e-gv8vacjh-EGO7ZcwYNSrALyQU1kDFruoFlyU
```

It runs on the Linux box as the `systemd --user` service `p2pchat-relay` (files in
`~/p2pchat-relay`, identity in `~/p2pchat-relay/data/relay-key.json`; keep that file, the address is
its public key). Change it in **Settings → Relay**; invites carry whatever relay the sender uses. The
relay forwards encrypted frames between random per-contact addresses and stores nothing. Messages to
someone whose app is closed wait on your device and go out when both are connected. Verified: two apps
with no LAN route to each other exchanged messages through it, and its journal contains no plaintext.

## Run from source

```sh
./run.sh                               # first window
./run.sh --instance=bob --x=900        # a second, independent one to talk to
```

No `npm install`, no runtime dependencies. `run.sh` points at an Electron binary already on this
machine and unsets `ELECTRON_RUN_AS_NODE`, which otherwise makes Electron start as a bare Node with no
window. (The packaged builds have that behaviour fused off.)

Dev runs keep their vault key in a plain file instead of the Keychain (test data; and a dev Electron
and an installed build would otherwise fight over the same Keychain entry). First launch asks for a display name. Then: **+** → **Show my invite** on one side, paste it into
**Add a contact** on the other. From then on the two find each other on every launch.

**Show / hide:** `⌘⌥V` on macOS, `Ctrl+Win+X` on Windows (change it in Settings; it is captured by
pressing the keys, and the Windows key / ⌘ is stored as `Super` so a combo means the same on every OS). The window also hides on close. If the hotkey cannot be registered (taken by another app),
the window stays open and says so, and a custom key that stops working falls back to the default. Quit
from Settings (macOS) or the tray icon (Windows).

## Building

### macOS signing identity (why updates stop asking for permissions)

Builds here are signed with a self-signed certificate, **P2P Chat Local Signing**, kept in its own
keychain (`~/Library/Keychains/p2pchat-sign.keychain-db`, password in `~/.p2pchat-sign-keychain-pass`).
It is not an Apple Developer ID, so other Macs still show the "unverified developer" dialog once, but
it is the *same* identity for every build: macOS binds the Screen Recording, microphone and
Accessibility permissions to the signing identity, so with an ad-hoc signature (`-`) every update was a
new app and each one asked again, and a stale "allowed" Screen Recording entry silently became "denied"
(that is what broke screen sharing after 0.4.0 was installed over 0.3.1). The Keychain is the exception:
the access list of the "P2P Chat Safe Storage" item records each build's code hash (`security
dump-keychain -a` shows `requirement: cdhash` entries, observed after installing 0.6.0 over 0.5.0), so a
self-signed build still gets the one Keychain prompt after every update. Enter the login password and
click **Always Allow**; the app waits at "safeStorage: checking availability" until that is answered. A
Developer ID identity is what makes that entry a stable requirement instead of a hash.
`P2P_MAC_IDENTITY=- npm run dist:mac` falls back to ad-hoc. To recreate the identity on another Mac:
make a code-signing certificate (openssl `-addext extendedKeyUsage=codeSigning`), import it into a
keychain with `security import -T /usr/bin/codesign`, `security set-key-partition-list`, add that
keychain to the search list, and `security add-trusted-cert -r trustRoot -p codeSign` (one password
dialog). When a build is still refused Screen Recording after an update, the app resets its own entry
(`tccutil reset ScreenCapture io.p2pchat.desktop`) and lets macOS ask again.


```sh
npm install              # electron-builder is the only (dev) dependency
npm run icon             # build/icon.png, drawn by code; .icns / .ico derived from it
cp main/turn.example.json main/turn.json   # call server (STUN/TURN) host + credential, never committed; see relay/README.md
npm run helper:mac       # compiles main/helpers/input-mac.swift (remote control) into a universal binary; needs the Xcode Command Line Tools; dist:mac runs it too
npm run dist:mac         # arm64 reuses the local Electron; x64 downloads one (~120 MB)
npm run dist:win         # NSIS installer, built on macOS, no wine needed
npm run dist:win:monitor # the same installer as the "monitor" variant (no capture blocking), into dist/monitor/
npm run dist:linux       # deb + AppImage
```

The ad-hoc fallback (`P2P_MAC_IDENTITY=- npm run dist:mac`, `identity: "-"`) is what lets a build launch on
Apple Silicon with no identity at all. Its consequences, all observed here before the local identity existed: a fresh install creates the Keychain entry silently and relaunching
the same build never prompts; **a new build is a new signature**, so the first launch after an update
stops on a Keychain prompt ("P2P Chat wants to use your confidential information stored in 'P2P Chat
Safe Storage'"). Enter the login password and click **Always Allow**. If it is denied, the app explains
and quits; nothing is lost, open it again and allow. A real Apple Developer ID removes both the
Gatekeeper step and that prompt, and is the one thing in this list that money fixes. Windows SmartScreen repeats
for every new file hash until a certificate builds reputation.

Fuses set on all three binaries: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` disabled,
asar integrity checked, app loaded only from the asar. In packaged builds DevTools and
`--remote-debugging-port` are refused, the renderer cannot navigate or open windows, every permission
request is denied, and only the app's own frame may call IPC.

### Linux

**Installed on the box (49.12.170.6) without root**, which is the path when `sudo` is not available:

```sh
# on the box, as the user
rsync -a dist/linux-unpacked/ ~/.local/opt/p2pchat/           # the unpacked build
~/.local/bin/p2pchat                                         # launcher: exec ~/.local/opt/p2pchat/p2pchat --no-sandbox "$@"
~/.local/share/applications/io.p2pchat.P2PChat.desktop       # Exec=~/.local/bin/p2pchat %U, StartupWMClass=io.p2pchat.P2PChat
~/.local/share/icons/hicolor/*/apps/p2pchat.png              # extracted from the deb with `dpkg -x`, no root needed
update-desktop-database ~/.local/share/applications
```

`--no-sandbox` is forced by Ubuntu 24.04: `kernel.apparmor_restrict_unprivileged_userns=1` blocks the
namespace sandbox for unconfined binaries, and `chrome-sandbox` cannot be made setuid-root without
root, so the app exits with `FATAL ... The SUID sandbox helper binary was found, but is not configured
correctly` (observed). `sudo apt install ~/p2pchat_<version>_amd64.deb` installs the AppArmor profile and
keeps the sandbox on; the deb is parked in the home directory for that.

Verified on the box under Xvfb: boot, window, `hotkey registered Super+Alt+X` (X11), relay up.
Without a keyring in the session the vault key is a plain `RAW:` file and Settings says so; inside a
GNOME session with gnome-keyring it is keyring-held. The core test suites also pass there under the
box's own Node 22 / OpenSSL (BoringSSL and OpenSSL differ on one JWK edge; the protocol does not rely
on it).

Opacity works there: verified on the box under an X server that the app finds its own window id and
writes `_NET_WM_WINDOW_OPACITY` (50 % → `2147483648`), the value Mutter applies in a GNOME X11 session
such as xrdp. Capture blocking cannot exist on Linux: X11 lets any client read any window and the
Wayland screenshot portal captures every surface, so the badge says so instead of pretending.

No background mode there: a global hotkey does not work on GNOME's default Wayland session
(22.04/24.04 lack the GlobalShortcuts portal backend; it works on "Ubuntu on Xorg"), and the tray needs
the AppIndicator extension. So the window keeps its dock entry and closing it quits. Screen-capture
blocking does not exist on Linux and the app says so. Without a running keyring the vault key is not
OS-protected and Settings reports that.

### Everything is saved

Every setting - both hotkeys, window mode, theme, opacity, pop-up switches, sidebar width and collapsed
state, and the code wrap/collapse choices - lives in the encrypted vault and comes back on the next
launch. Verified by setting all of them, relaunching, and reading them back unchanged.

### Logs

`Settings` shows the log path (`~/Library/Logs/P2P Chat/`, `%APPDATA%\P2P Chat\logs`, `~/.config/P2P Chat/logs`).
It never contains message text, names or keys.

## What it does

| | |
|---|---|
| **No identifiers** | Long-term X25519 keypair generated on first run, kept only in the encrypted vault. No phone number, username or directory. Contacts are made by passing a one-time invite out of band. |
| **Peer to peer** | Direct TCP between the two apps on a LAN; through a blind relay otherwise. Direct is preferred whenever it works: dialing tries the LAN address first, and a session that came up through the relay retries the LAN address shortly after and every 30 s, switching over when it connects. Each app listens on a fixed port it picked on first run, so a contact's saved address stays valid across restarts. |
| **Encryption** | IK-shaped handshake per connection: the initiator's static travels encrypted under `es`, the payload under `es‖ss` (so opening it proves the initiator holds that static's private key), then es, ss, ee, se mixed through HKDF-SHA256 with a transcript hash → one chain key per direction → one AES-256-GCM key per message, used once and zeroed. The responder changes nothing until the initiator's first encrypted frame opens, so a replayed handshake gets an answer and nothing else. |
| **History** | Every message is stored on both devices in a vault encrypted with AES-256-GCM. The vault key is wrapped by the OS keychain (`safeStorage`). On every connect the peers exchange what they hold and resend what the other lacks, so messages written while someone was offline arrive when they return. **Restore history from peer** rebuilds a lost conversation from the other device's copy. |
| **Code** | `</>` or `⌘E` for code mode, `⌘↩` to send. Fenced blocks typed as text (` ```py … ``` `) become code. Pasting something that looks like code switches mode and guesses the language. Rendered with a built-in highlighter and a Copy button. |
| **Screenshots** | 📷 in the composer: one click captures the display the window is on and sends it. With capture blocking on, macOS and Windows leave the chat window itself out of the shot (that is what the blocking is); on Linux, or with blocking off, the window is hidden for the shot. JPEG, long edge capped at 2560 px. The record travels as a normal message; the receiver then pulls the bytes one 96 KB part at a time (the next ask goes out when the previous part is in, so a sender never has more than one part in flight per peer, whatever a peer asks for), frames stay under the 256 KB cap, the relay is unchanged, and offline catch-up and restore-from-peer carry images too. Stored as one sealed file per image next to the vault (AES-256-GCM, same key, fsynced), never inside it; a damaged file is dropped and pulled again. Click an image to view it full size; Copy puts a PNG on the clipboard; Save… writes the file. macOS needs Screen Recording permission once: the app says so and opens the setting. |
| **Screen share with voice** | **⇡ Share screen** in the chat header: one click sends the display the window is on, plus your microphone, to that contact. Nothing else opens on your side: the button turns into **■ Stop sharing** and a red **Sharing** pill appears (the sidebar row shows "● sharing"; on the watching side "● live"). The ▾ next to it picks the mode, saved for next time: **one way** (default) sends only yours; **two way** also asks the contact to share theirs through an in-app prompt ("Share my screen" / "Just watch"). The contact sees your screen in a panel at the top of the chat with the messages still usable underneath, with mute, fullscreen, **Talk** (sends their mic back), **Share mine** (turns it two-way at any point) and **End**. Media is WebRTC inside the app's own window (hardware video, Opus audio with echo cancellation, DTLS-SRTP), and the signaling travels over the chat's end-to-end channel, so the media keys are authenticated by the same long-term keys as the messages. Between two home networks it goes through the call server from Settings (coturn on your box, STUN + TURN; it only ever sees encrypted media; "route through the server only" hides your IP from the contact). The capture-blocked chat window is left out of what you share, like screenshots. Capped at 2560 px wide, 30 fps and 8 Mb/s, VP9 first (its screen-content mode keeps text sharp). The viewer paints each frame when it arrives: no jitter cushion and no hold for lip sync. The price is that a lost packet shows as a short stall where the cushion used to hide it; starting the app with `--share-cushion` brings the cushion back. The viewer bar shows resolution, frame rate, bit rate, codec, round-trip time and whether the path is direct or through the call server, and in between where the delay sits, as averages over the last 2 s in milliseconds: `buf 0 (+0 sync) want 21 dec 2 ms · shown +26 ms · nack 0 frz 0`. **buf** is how long a frame waited in the receive buffer, and `+N sync` the part of it that lip sync or a set minimum added; **want** is the buffer the network's jitter alone would ask for; **dec** the time to decode a frame; **shown** the time from a frame's last packet to the frame on screen; `nack` counts retransmissions asked for and `frz` freezes. The sharer's half is the tooltip of the Sharing pill: frames per second into the encoder and out of it, milliseconds per encoded frame, frames skipped, and what holds quality back (cpu or bandwidth) when something does. Both sides write that line to the app log every 10 s. A share keeps running while the window is hidden. The viewer's **⤢** makes the share full screen (the window itself, so it works in every window mode; Esc, ⤡ or a double-click leaves), and the full-screen hotkey **⌘⌥↩** / Ctrl+Win+Enter (Settings) toggles it from anywhere, also while you control their screen and Esc and clicks go to them. **● Record** in the viewer, or Settings → "Record incoming screen shares", writes what you see and hear from them to a `.webm` file in the Videos folder (`~/Movies/P2P Chat` on macOS); switching the setting on during a share starts recording that share at once, and the contact's Sharing pill reads "recorded" for as long as it runs. **🖱 Control** in the viewer asks the sharer for their mouse and keyboard, the way RustDesk or AnyDesk do: they get a dialog that names you, with the first characters of your key and whether they have verified you (Allow / Deny; the keyboard starts on Deny and Esc is Deny, Allow takes no click for the first 0.8 s, an unanswered dialog closes after 40 s, and after a Deny your next request within 10 s gets a no without a dialog) and, once allowed, your pointer, clicks, scrolling and keys on the video act on the display they share (pointer moves go out as the device reports them, at most one per 8 ms) (physical keys, so their keyboard layout applies; two clicks are a double click; a held button drags; over the video your pointer takes the shape of theirs: a Mac sharer's helper sends its system cursor image whenever it changes, Linux and Windows sharers leave you a plain arrow, since the shared picture itself carries no pointer). Their pill reads "controlled" and a **✋ Stop control** button next to it, shown in every chat for as long as someone controls, ends it at any moment, as does stopping the share. Events travel on data channels of the same encrypted connection, and a small helper on the sharer's side posts them to the OS: a compiled binary on macOS (needs **Accessibility** access, asked for on the first Allow), `python3` with XTest on Linux (X11 sessions only), PowerShell with `SendInput` on Windows. Nothing is controllable unless the sharer allows it, per share. |
| **Share to several contacts** | The ▾ next to Share has **Several contacts…**: your contacts with a tick each, up to 4, and **Start sharing**. One capture of the display goes to everyone ticked. They see your screen and hear your microphone, not each other, and none of them is told who else watches, only how many ("3 watching" in their viewer bar). While a share runs, the Share button in any other chat reads **＋ Add to share** (one click, no second capture), and in the chat of a contact who gets your screen **■ Stop sharing** stops it for that contact alone. A bar above the chat says who gets your screen, who controls it, whether the clipboard is shared and who records, with **Audience…** (the list again, to add or drop contacts), **✋ Stop control** and **Stop sharing** for everyone; a share with only the contact whose chat is open has no bar and looks as it always did. The microphone button is one switch for everyone who gets your screen. Each viewer has an encoder of its own, so the picture steps down with the audience: with one or two viewers each gets the full 2560 px, 30 fps and 8 Mb/s; with three, 1920 px, 20 fps and 5 Mb/s each; with four, 1920 px, 15 fps and 4 Mb/s each; the one who controls your screen keeps 30 fps and at least 5 Mb/s. One contact controls at a time: while one does, or while their request waits for your answer, anyone else who asks is told the screen is being controlled by someone else, and no second dialog opens. A viewer who drops offline while others still watch is shown as reconnecting and gets the screen back without a click if they return within a minute. Up to 6 share sessions run at once, counting the ones where you only watch. |
| **Clipboard with remote control** | While a contact controls your screen, copied text can travel both ways: text copied on the shared computer (by them through the share, or by you) lands on their clipboard (the app looks twice a second), and text they copy on their own machine lands on yours when they come back to the shared screen (their window gets the focus, or their pointer enters the video). Both sides have to agree to it in that one request. Each has the Settings switch "Share clipboard text during remote control", on by default; with both on, the sharer's dialog shows a ticked box "Share clipboard text with NAME while they control" and its button reads **Allow control and clipboard**; unticked, it allows control alone. When the box is not offered, the dialog says why (the other side did not offer it, your own switch is off, or the clipboard is already shared in another session). While it is on, the sharer sees "· clipboard" in the pill and a green **📋 Shared** button in the header of every chat, the viewer a **📋 Shared** button in the viewer bar. Either side ends it with that button or with the Settings switch: control goes on, and the clipboard stays off until a new request is allowed. It always ends when control ends. Text only, up to 64 KB per copy; a larger copy is skipped and the button reads "Too large" for a moment. Text that was on a clipboard before the sharing started is never sent, and the app never logs or shows clipboard text. One clipboard is shared at a time. A contact on 0.7.1 or older never offers it, so with them nothing touches either clipboard. |
| **Shortcuts while controlling** | In full screen, while you control the screen it shows, the keys this app would otherwise act on itself go to the remote screen like every other key: the shortcuts of the application menu (copy, paste, cut, select all and undo among them) and the opacity keys. Out of full screen they act here, as before. The three global hotkeys (show and hide, window mode, full screen) always stay with your machine, so the full-screen hotkey is the way out. |
| **Capture blocked** | `setContentProtection(true)` on every window, default on. macOS: `NSWindow.sharingType = none`. Windows: `SetWindowDisplayAffinity`. Linux: nothing exists, and the UI says so. The **monitor** variant of the Windows installer (`npm run dist:win:monitor`) is built without it: its window is an ordinary one that screenshots, recordings and screen shares show, and the shield, the Settings switch and the tray item for blocking are gone. Nothing else differs: a screen share still starts only on your own click, the red Sharing pill still shows for as long as it runs, and control and the clipboard still need your Allow in the dialog. Wherever viewers of your screen can read this window (that variant, Linux, blocking switched off), during a share to more than one contact it names none of them outside the control dialog and the list you tick them in: the bar counts them, the contact rows carry no mark, and that list warns that viewers can read it. |
| **Background app** | `LSUIElement` + `app.dock.hide()` and no `Tray` on macOS (process reports as `UIElement`), `skipTaskbar` + `Tray` on Windows, `globalShortcut` for show/hide, close hides, optional start at login. Not on Linux (see above). |
| **Themes** | System / Dark / Light in Settings, applied instantly and persisted. One token layer (`ui/theme.css`) holds two complete palettes selected by `<html data-theme>`; every component in `ui/app.css` uses tokens only (no literal colors), `color-scheme` makes native controls match, the window background is set to the theme before first paint, and "System" follows the OS live. `test/theme-contrast.js` checks 72 foreground/background pairs per build against WCAG floors (body text 7:1, secondary and accent text 4.5:1, code syntax colors 4.5:1). |
| **Responsive** | Works from a full window down to 360x320. Below 640px wide it becomes a single pane with a ☰ button that swaps between the contact list and the conversation; above that, ☰ (or ⌘/Ctrl+B) collapses the sidebar, and a drag-handle on the sidebar edge resizes it 220-480px (double-click resets). Below 600px tall the status strip goes compact. Every layout choice is saved. |
| **Messages** | URLs become links that open in your real browser (never in the app; only http/https, length-capped), emoji-only messages render large and frameless, each bubble has a Copy button on hover, timestamps and ticks collapse on grouped runs, and a "N new" divider marks where you left off (unread keeps counting while the window is hidden). Long unbroken strings wrap instead of overflowing. |
| **Code blocks** | Wrap by default so nothing scrolls sideways in a narrow window, with a per-block Wrap/Scroll toggle; blocks over 18 lines collapse behind a "Show all" button with a fade. Both the wrap choice and the collapse setting are saved. |
| **Message pop-ups** | A new message while the chat is hidden or not in front pops a small card at the top-right of the screen with the sender and the text (or just "sent a message", if you turn the text off in Settings). It is drawn by the app, not the OS: no app name or icon, nothing in Notification Center, never takes focus, click-through, gone after 6 s, more messages stack as "+N more", and it is capture-blocked like the main window. Settings has the two switches and a Preview button. |
| **Window modes** | Settings → Window mode, or cycle with **⌘⌥⌫** / Ctrl+Win+Backspace (configurable). **Overlap**: a normal window, takes your clicks, other windows can cover it. **On top**: floats above every window, still interactive. **Overlay**: floats above everything *and* passes every click and keystroke through to the app behind it (`setIgnoreMouseEvents` + non-focusable), meant to be paired with a low opacity to keep the chat in view while you work. The mouse cannot reach the window in Overlay, so the mode hotkey is the way back; if that hotkey can't be registered at start, the app refuses to start in Overlay and says so. The current mode shows at the bottom of the sidebar, and every change pops a toast naming the key. |
| **Window opacity** | Slider at the bottom of the sidebar, 20-100 %, double-click resets, or **⌘-** / **⌘+** (Win- / Win+ on Windows and Linux) in 10 % steps while the chat window is focused; holding the key keeps stepping. Deliberately not a global shortcut: ⌘+/- is zoom in every other app, and Windows owns Win+Plus for Magnifier (Windows 11 can turn that off under Settings → Accessibility → Magnifier), so Windows also accepts Ctrl+Alt+'+' / '-'. At low values whatever is behind the window shows through; capture blocking is unaffected. Persisted. macOS and Windows use `setOpacity`; on Linux that call is a no-op, so the app sets `_NET_WM_WINDOW_OPACITY` on its own X11 window through `xprop`, which compositing window managers (Mutter, KWin, xfwm) honour. The slider appears on Linux when the session is X11 and `xprop` is installed; Wayland sessions have no equivalent and hide it. |
| **Safety number** | 60 digits, 30 derived from each static key on its own (so a man in the middle cannot birthday-search one combined hash), stable per contact. Compare it aloud once; mark the contact verified. It is the only MITM check there is. |

## Verified by running it

macOS 26.2, Apple Silicon, Electron 45.1.0 (bundled Node 24.22.1 on BoringSSL):

- **Capture:** `screencapture` and a purpose-built Swift ScreenCaptureKit capturer, including a
  mid-stream filter update re-including every window and a window-targeted filter, could not read
  the window. Window-targeted SCK returns pure black. Same window with protection off: readable.
- **Crypto + state, headless under Electron's runtime:** `test/run.sh`, 62 assertions: impostor
  responder, stranger with forged token, prototype-name tokens, hs1 claiming someone else's static,
  replayed hs1, tamper without desync, junk bytes before the handshake, unsolicited history frames,
  remove-and-re-add sequence continuity, oversized messages, offline queue → catch-up in order without
  duplicates, wipe → restore with correct direction mirroring, simultaneous dial collapsing to one
  connection, vault bytes containing no plaintext.
- **UI, driven over CDP against the shipped renderer:** first-run naming, invite → add, auto-select,
  text, code mode with highlighting, fenced-block conversion, paste detection, delivery ticks, typing
  indicator, matching safety numbers, settings; quit → messages queued with ○ → relaunch → ✓✓;
  wipe → restore 7 messages; restart both → identity, ports, contacts and history all back from the vault.
- **Background behaviour:** `lsappinfo` reports the process as `type="UIElement"` (no Dock tile); a
  `⌘⌥X` sent through System Events toggles the window (no status-menu item on macOS by design).

- **Screenshots:** two dev instances on this Mac with both windows on screen. 📷 sent a 1920×1200 JPEG
  (131 KB) that was on the peer's screen within a second, decoded at full size on both sides, opened in
  the viewer, copied as PNG, and was still there after both apps restarted. The decrypted capture shows
  the desktop and the other apps, and neither chat window: the OS leaves a protected window out even
  when the app itself is the one capturing. Engine suites cover record-only frames, sealed files,
  offline queue, restore-from-peer, a 700 KB image through the relay, forged or oversized input, and
  from the review: an ask flood that costs the sender one part, a 62-image restore, the quota and a
  forced fetch, a corrupt file healing itself, no ghost record on a failed write, and a Cyrillic
  history restore (131 assertions in all).

- **Screen share:** two dev instances on this Mac (fake microphone device, real screen): one click gave
  "Sharing" with no panel on the sharer's side and a 1920×1200, 15 fps, ~1 Mb/s stream with an audio track
  on the viewer (audio confirmed by inbound RTP packet and energy counters, since the fake tone measures
  near-silent after noise suppression); Talk added the viewer's audio to the sharer; two-way put both
  screens up, through the prompt and through "Share mine"; stop and End left both sides idle; with
  "route through the server only" on both sides the stats read "via call server". Then across the
  internet: this Mac (home NAT) and a dev instance on the Linux box under Xvfb met through the chat relay
  and shared both ways, direct and TURN-only, 0 errors on both sides. The TURN server itself was checked
  with a zero-dependency STUN/TURN client first (binding, 401, authenticated allocation, wrong password
  refused).

- **Viewer full screen and recording (0.5.0):** between two dev instances on this Mac, the viewer's ⤢ put the
  window into full screen (window flag true, page 1920×1056 = the screen) and ⤢ again restored 1080×740;
  ● Record for 4 s wrote a 450 KB `.webm` (EBML header) while the button counted time and size and the
  sharer's pill read "Sharing · recorded", back to "Sharing" on stop; the Settings switch turned on during the
  share started a second recording (358 KB) that the switch turned off again; 0 errors in either log
  (test/ui/share.sh, steps 1b-1d; the script has since stopped reading a recording's bytes and prints its
  size instead).

- **Remote control (0.6.0):** between two dev instances on this Mac, 🖱 Control opened the sharer's dialog naming
  the asker; Allow turned the viewer's button into "Controlling", the sharer's pill into "Sharing · controlled" with
  the ✋ button beside it, and started the macOS helper (`ready trusted=1`, display 1920×1200). A pointer move sent
  through the viewer landed exactly where asked (5 px off and back, read with CGEventGetLocation). ✋ ended it on
  both sides and stopped the helper; a second request was denied and the viewer was told. Both data channels
  open, 0 errors in either log (test/ui/share.sh, steps 1e-1f as they were then; today the script runs these
  two steps against `--dry-input`, where no helper starts, and its pointer part only with `REAL_INPUT=1`). The Linux helper was run on the box against an
  Xvfb display: pointer moved to the commanded spot, a held button and a held Shift showed in the X pointer mask,
  reset and end-of-input cleared both. Not verified here: a click or keystroke landing in another application's
  window (the harness does not inject into a live desktop), and the Windows helper beyond starting and compiling
  its SendInput shim.
- **Remote control under Jump Desktop (0.6.1):** the first real session (this Mac sharing to a Linux box, both
  reached over remote desktop) moved the pointer but landed no click or key. The Mac's log showed the helper
  trusted, 234 events in, none dropped; `CGGetEventTapList` showed Jump Desktop Connect's privacy blocker holding
  an active (filtering) event tap at the HID point for buttons, moves, keys, flags and wheel (its Agent log:
  "Blocking mouse and keyboard: true" at the session start), the point the helper posted at. The helper now posts
  at the session point; a pointer move through the rebuilt helper, with the Jump session active, landed at +5,+5
  and returned exactly. Clicks and keys through it are still not exercised here (nothing is injected into the
  live desktop); the next real session is that test.
- **Share latency (after 0.7.1):** `test/ui/latency.sh` on two dev instances on this Mac, real screen, a square
  animated in the sharer's window: the viewer read buffer 0 ms, decode 2 ms, 25-31 ms from a frame's last packet to
  the screen and 31-37 ms from capture to the screen, 58-59 frames in every 2 s window, none dropped, no freeze; the
  sharer 29-30 fps into the encoder at 4-6 ms per frame, with nothing limiting quality (VP9, libvpx).
- **Several viewers, clipboard with control, shortcuts while controlling (after 0.7.1): not yet run against a real
  screen capture.** Two things stand in for it so far. The headless suites (`test/share-test.js`,
  `test/control-test.js`, `test/clip-test.js`, run by `test/run.sh` under Electron's runtime) cover the audience and
  its limit, the encoder values per viewer, the one controller with its token in the main process, the dialog's
  rules (Deny on Esc, Allow armed late, expiry, cooldown), the clipboard link on both sides over a clipboard held in
  memory (what is sent, what is not, off being final) and the page's side of the shortcut switch. And `test/ui/cast.sh` drove the real
  app, five dev instances on this Mac, with a drawn test picture in place of the screen capture
  (`CAST_CANVAS=1`), which leaves the connections, the encoders and the data channels real: two contacts from
  one capture through the list, the bar and the marks on the contact rows, "2 watching" on the viewers, the
  microphone as one switch, a viewer leaving, **＋ Add to share**, stop for one and for all, the audience limit,
  two, three and four viewers with their encoder values, the nameless wording with capture blocking off, the layout
  at two window sizes, the control dialog (who asks, the key, Deny first, Allow armed late), a second request
  turned away while the first waits, a yes nobody asked for, the dialog's clipboard box and its notes, a request
  running out after 40 s, Deny and its cooldown, talking back, and a viewer's app quitting: 64 marked readings,
  none off, no error in any log. In that mode the main process knows of no shared display and so allows no control:
  a granted control session with several viewers and the clipboard link end to end have run in the headless suites
  only, and two things not at all: the main process telling Electron to leave its menu shortcuts alone, and the bar
  staying above a full-screen viewer while someone controls. `sh test/ui/cast.sh` on a machine whose screen can be
  captured runs all of it, with input dropped and clipboards held in memory. Three things no script can
  check: the shortcuts on a real keyboard, whether macOS puts up a notice of its own when the app reads the
  clipboard, and whether a password manager's copy is held back.

### Two bugs only the real app caught

1. `chacha20-poly1305` passed every test under system Node and threw `ERR_CRYPTO_UNKNOWN_CIPHER` in
   Electron, which bundles BoringSSL (28 ciphers, no ChaCha). Now `aes-256-gcm`, asserted at load.
2. `hs2` and the first encrypted `sync` arriving in one TCP chunk lost the `sync`: the handshake's
   frame listener was swapped for the session handler across an `await`. Now every connection queues
   frames and drains through an explicit handler (`core/transport.js`).

Also: Electron 45's `safeStorage.decryptStringAsync` resolves to `{ shouldReEncrypt, result }`, not a
string, and the sync `isEncryptionAvailable` races the keychain at startup. Both handled in `main/main.js`.

### What an adversarial review found, and what changed

Nineteen reviewer and refuter agents read `core/` and `main/` with crypto, state-machine and Electron
lenses; every finding below was independently reproduced before it was fixed.

| Finding | Fix |
|---|---|
| `invites[token]` on a plain object is truthy for `"constructor"`, `"__proto__"`…: anyone with your public key and port could become a contact | `Object.hasOwn` and shape checks on every lookup keyed by peer- or renderer-supplied strings; tokens validated before `accept()` |
| hs1 was encrypted under `es` alone, so a forged hs1 could claim a contact's public key and rewrite that contact's address or drop its live session | Payload under `es‖ss`; no state change until the initiator's first encrypted frame opens |
| Unsolicited `hist` frames were merged raw: a peer could plant messages as you, push `mySeq` to 2^53, or brick the contact list | Honoured only while a request is outstanding; every record sanitized; chunks sized by bytes |
| `emit('error')` with no listener before the handshake: four junk bytes from any LAN host crashed the main process | Guarded emit; no-op listeners during the handshake |
| Remove + re-add restarted `seq` at 1; the peer dropped the new messages as duplicates while the sender saw ✓✓ | Dedupe by message id; `mySeq` raised from the peer's `sync` |
| Safety number hashed the key *pair* (~2^50 birthday search for a MITM choosing both keys) | 60 digits, 30 per key |
| Discovery minted a never-expiring token every 3 s; hotkey failure at boot was reported as success; no fsync before rename; no single-instance lock; minimize had nowhere to go | One token per discovery session, invites expire after 24 h and cap at 50; honest hotkey result; fsync; `requestSingleInstanceLock`; `minimizable: false` |

A second review ran over the screenshot feature (five lenses, 28 raw findings, nine sent to three
refuters each, eight stood). All eight were fixed the same day, each with a regression test:

| Finding | Fix |
|---|---|
| `breq` answered the whole image at once with no per-peer limit: a contact sending asks in a loop could queue gigabytes in the sender's write buffer and freeze or OOM the process | Receiver-driven pulls: an ask names one part, the sender keeps one part in flight (the socket write callback clears it) and serves at most 40 parts/s per peer; extra asks are dropped |
| With the window hidden for a shot (Linux, or blocking off) a message pop-up from another contact could land in the screenshot | Pop-up hidden and suppressed, and the window kept hidden, for the duration of the capture |
| History chunks were sized in UTF-16 units (pre-existing): Cyrillic or CJK history made frames over the cap, which closed the connection, or dropped the whole relay link, on every restore | Chunks sized in UTF-8 bytes; a frame the relay would refuse now fails that one channel, not the link |
| The 60 s pull timer was a total timer: on a slow link a large image never arrived and was re-sent in full on every reconnect | A stall timer, refreshed by every part |
| Only the newest 50 missing images were queued and never rescanned: a restore of more than 50 screenshots left the rest as placeholders | Rescan when the queue drains after a success |
| No cap on pulled bytes: a contact could fill the disk, after which the timer-driven vault save threw uncaught and nothing persisted any more | 512 MB of images per contact before auto-download stops (a Download button fetches past it); a failed save is reported, not thrown |
| A damaged or zero-length blob file counted as held forever, and blobs were not fsynced | Size and decrypt checks; a file that does not open is removed and pulled again; fsync before rename |
| The record was stored before the bytes: a failed write left a placeholder forever on both sides | Bytes first, then the record |

Lower-rated findings from the same run were fixed too: recursion in the pull queue, negative part
counts, source selection where `display_id` is empty (Linux, Windows without DirectX), a screenshot
filed under whichever chat was open when the capture finished, placeholder height from peer-chosen
dimensions, refreshes clearing unread on a hidden window, Copy "succeeding" on undecodable bytes,
Windows device names (`NUL`, `COM1`…) as blob file names, a macOS permission granted mid-session
(blank until relaunch), and `pictures` being unavailable for Save.

## Limits

- **Across the internet you need a relay**, and the relay sees your IP and which of its random addresses talk to each other (not who you are or what you say).
- **Not a Double Ratchet.** Forward secrecy per session and per message, but no post-compromise
  security inside a session (no DH re-keying). Reconnecting starts fresh keys.
- **Both sides must be running for a message to move.** The relay stores nothing. Pending messages
  wait on the sender's device; the app is a background app so "running" is the normal state.
- **Capture blocking stops software, not a camera**, and protects your machine only. A capturer can
  still see that the window exists (title, position); it cannot read its pixels.
- **Running two instances on one machine** (`--instance=`) registers the same hotkey twice; whichever is focused hides.
- **Screen share**: one session per contact, up to 6 at once; your screen goes to at most 4 contacts, all from
  one capture, and they do not see or hear each other; the microphone, not system audio (Electron captures system
  audio on Windows only); on Linux, and in the monitor build, the chat window is part of what you share (no capture
  blocking there); the call server's credential is inside the app, so anyone who extracts it can use that server's
  bandwidth (capped at 20 Mb/s per session, private addresses refused). Not a call feature yet: no ringing, no
  camera, no group call. When the last viewer of a share to several contacts drops, the capture stops with it and
  nobody is added again: start it anew from the list.
  Recordings are plain `.webm` files outside the vault; they hold the contact's screen and voice (not your own
  talk-back) and stop when their screen stops.
- **Remote control** needs, on the sharer's side, Accessibility access on macOS, an X11 session with `python3` on
  Linux (Wayland is refused; the deb depends on `python3` and `libxtst6`, the AppImage assumes them), and PowerShell
  on Windows. Keys are sent as physical keys, so what a key types follows the sharer's layout. Keys the viewer's
  own operating system keeps for itself (⌘-Tab, Alt-Tab and the like) are not captured and never reach the sharer,
  in full screen or out of it. The app's own menu shortcuts and opacity keys reach the sharer only in full screen
  (*Shortcuts while controlling*); that rests on Electron leaving its menu shortcuts alone when asked to
  (`setIgnoreMenuShortcuts`) and has not been pressed through on a real keyboard yet, because a test driver's key
  events do not pass the menu. Esc leaves the viewer's full screen only while control is off. No file transfer, no
  system audio.
- **Clipboard with remote control** is text only, at most 64 KB per copy: no images, no files, no formatting. It
  exists only inside a control session the sharer allowed, with the Settings switch on on both sides. While it is
  on, the app reads the sharer's clipboard twice a second and the viewer's when they come back to the shared screen;
  whether macOS shows a notice of its own for such reads has not been checked on a real clipboard. The app asks the
  system for the marks password managers put on what they copy and skips a copy that carries one, but whether each
  system shows those marks to the app is untested: treat everything copied while the clipboard is shared as sent.
  Where a system refuses that question outright, the app takes the clipboard for marked and sends nothing from
  that machine.
  A text already on its way when control ends can still arrive.
- **Remote control under a remote-desktop host:** tools that block local input on the shared computer (Jump
  Desktop Connect's privacy mode, for one) do it with a filtering event tap at the HID point of the event stream.
  Until 0.6.1 the helper posted its clicks and keys at that same point, so such a tap swallowed them while the
  pointer still moved. Since 0.6.1 it posts at the session point, which sits after the HID taps.
- **Hotkey defaults changed in 0.7.x:** Ctrl+Win+X (show, hide), Ctrl+Win+Backspace (window mode) and Ctrl+Win+Enter
  (full screen for a share) on Windows and Linux; ⌘⌥V, ⌘⌥⌫ and ⌘⌥↩ on macOS. A stored copy of any earlier default moves
  to the current key at the first start; a custom key stays. On Windows, Ctrl+Win+Enter is also Narrator's shortcut: if the app cannot register
  it, pick another key in Settings or turn Narrator's shortcut off (Settings → Accessibility → Narrator).
- **Screenshots are pulled whole, without backpressure**: 8 MB cap per image, parts written to the socket in one go,
  one image at a time per peer, one part in flight, at most 40 parts/s per peer. Auto-download stops at 512 MB of
  images per contact (a Download button fetches past it). On Wayland the capture goes through the desktop portal,
  which needs the installed `.desktop` entry: the deb, not the AppImage.
- **Unaudited.** Hand-rolled protocol. A prototype, not something to trust with real secrets.

## Layout

```
core/crypto.js      keys, IK-shaped handshake, per-message ratchet, vault sealing, invites, safety number
core/store.js       encrypted vault: identity, contacts, conversations, issued invites, settings; image bytes as sealed files in vault-blobs/
core/transport.js   TCP framing with a drained frame queue; optional UDP LAN discovery
core/engine.js      sessions, LAN-then-relay dialing, reconnect with backoff, sync / ack / history protocol
core/relaylink.js   encrypted link to a relay, ed25519 addresses with ownership proofs
core/relay.js       relay client: one link, bound addresses, channels that behave like TCP Conns
relay/server.js     the relay itself (zero dependencies); relay/README.md to deploy it
main/main.js        Electron: window, content protection, tray, hotkey, keychain-wrapped vault key, IPC, logging
electron-builder.config.js  packaging for mac / win / linux; build/make-icon.js draws the icon
main/preload.js     the only surface the renderer gets
main/icon.js        draws the tray icon at runtime (no image assets)
main/input.js       remote control: runs the input helper (main/helpers) for the one contact who was allowed
main/grant.js       that one grant and its token; main/clip.js the clipboard link that can come with it; main/sharepop.js one pop-up per incoming share
ui/                 index.html, theme.css (tokens, two palettes), app.css (components), app.js, highlight.js
ui/share.js         screen share (WebRTC): the header, the viewer bar, the audience list and bar, window.Share
ui/share/           its parts: kit (namespace), tune (latency and quality values), session, cast (capture, microphone, audience), control, clip, record, viewer
```

v0.1 (ephemeral identity, no history, single chat) is kept at `../p2pchat-v0.1`.
