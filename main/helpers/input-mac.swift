// P2P Chat input helper for macOS: posts the mouse and keyboard events of a screen-share
// remote control to the OS. Built by make-mac.sh into a universal binary next to this file.
//
// Protocol (one command per line on stdin, numbers are display points, see main/input.js):
//   m X Y            move the pointer
//   d B X Y          button B (0 left, 1 right, 2 middle) down at X Y
//   u B X Y          button up
//   w DX DY X Y      wheel, DX/DY in pixels (positive = content scrolls right / down)
//   k CODE 1|0       key down / up, CODE = CGKeyCode (kVK_*)
//   r                release everything held
// "ready" and errors go to stderr, the cursor shape to stdout (see pollCursor). Everything held
// is released at "r" and at end of input.
// Needs Accessibility access (the app asks for it before starting this helper).
import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

let src = CGEventSource(stateID: .hidSystemState)
var flags = CGEventFlags()
var heldKeys = Set<CGKeyCode>()
var heldMods = Set<CGKeyCode>()
var heldButtons = Set<Int>()
var pos = CGPoint(x: 0, y: 0)
var lastClick = (time: 0.0, button: -1, count: 0, pos: CGPoint.zero)
let MODS: [Int: CGEventFlags] = [56: .maskShift, 60: .maskShift, 59: .maskControl, 62: .maskControl,
                                 58: .maskAlternate, 61: .maskAlternate, 55: .maskCommand, 54: .maskCommand, 63: .maskSecondaryFn]

func say(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
// Posted at the session tap, not the HID tap: remote-desktop hosts (Jump Desktop Connect's privacy
// blocker, for one) filter the HID point with an active event tap and swallow synthetic clicks and
// keys posted there. The session point sits past the HID taps and still moves the cursor.
func post(_ ev: CGEvent?) { guard let ev = ev else { return }; ev.flags = flags; ev.post(tap: .cgSessionEventTap) }
func cgButton(_ b: Int) -> CGMouseButton { b == 0 ? .left : b == 1 ? .right : .center }

func move(_ p: CGPoint) {
    pos = p
    let held = heldButtons.contains(0) ? 0 : heldButtons.contains(1) ? 1 : heldButtons.contains(2) ? 2 : -1
    let type: CGEventType = held == 0 ? .leftMouseDragged : held == 1 ? .rightMouseDragged : held == 2 ? .otherMouseDragged : .mouseMoved
    post(CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton(max(0, held))))
}

func button(_ b: Int, down: Bool, at p: CGPoint) {
    pos = p
    let now = Date().timeIntervalSince1970
    if down {
        let again = b == lastClick.button && now - lastClick.time < 0.5 && abs(p.x - lastClick.pos.x) < 6 && abs(p.y - lastClick.pos.y) < 6
        lastClick = (now, b, again ? lastClick.count + 1 : 1, p)
    }
    let type: CGEventType = b == 0 ? (down ? .leftMouseDown : .leftMouseUp) : b == 1 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
    let ev = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton(b))
    ev?.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, lastClick.count)))   // 2 = double click
    post(ev)
    if down { heldButtons.insert(b) } else { heldButtons.remove(b) }
}

func wheel(dx: Int32, dy: Int32, at p: CGPoint) {
    let ev = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0)
    ev?.location = p
    post(ev)
}

func key(_ code: Int, down: Bool) {
    let k = CGKeyCode(code)
    if let m = MODS[code] {
        if down { flags.insert(m); heldMods.insert(k) } else { flags.remove(m); heldMods.remove(k) }
        let ev = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down)
        ev?.type = .flagsChanged
        post(ev)
        return
    }
    post(CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down))
    if down { heldKeys.insert(k) } else { heldKeys.remove(k) }
}

func reset() {
    for k in heldKeys { post(CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)) }
    heldKeys.removeAll()
    for b in Array(heldButtons) { button(b, down: false, at: pos) }
    flags = CGEventFlags()
    for k in heldMods { let ev = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false); ev?.type = .flagsChanged; post(ev) }
    heldMods.removeAll()
}

// Cursor shape: while the helper runs, the system cursor (whichever app set it) is read ten
// times a second and written to stdout when it changes, so the viewer can draw the real
// pointer where it points: "cursor W H PW PH HX HY PNG" (W H and the hot spot in points,
// PW PH in pixels, PNG base64).
var lastCursor: Data? = nil
func pollCursor() {
    guard let c = NSCursor.currentSystem, let tiff = c.image.tiffRepresentation else { return }
    if tiff == lastCursor { return }
    lastCursor = tiff
    // drawn at 2x of its point size: the native bitmap can be far larger (a 28x40 pt cursor came as 280x400 px)
    let sz = c.image.size, hs = c.hotSpot, pw = Int(sz.width) * 2, ph = Int(sz.height) * 2
    guard pw > 0, ph > 0, pw <= 256, ph <= 256,
          let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    c.image.draw(in: NSRect(x: 0, y: 0, width: pw, height: ph), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    let line = "cursor \(Int(sz.width)) \(Int(sz.height)) \(rep.pixelsWide) \(rep.pixelsHigh) \(Int(hs.x)) \(Int(hs.y)) \(png.base64EncodedString())\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func handle(_ line: String) {
    let p = line.split(separator: " ").map(String.init)
    guard let cmd = p.first else { return }
    func num(_ i: Int) -> Double { i < p.count ? (Double(p[i]) ?? 0) : 0 }
    switch cmd {
    case "m": move(CGPoint(x: num(1), y: num(2)))
    case "d", "u": let b = Int(num(1)); if b >= 0 && b <= 2 { button(b, down: cmd == "d", at: CGPoint(x: num(2), y: num(3))) }
    case "w": wheel(dx: Int32(num(1)), dy: Int32(num(2)), at: CGPoint(x: num(3), y: num(4)))
    case "k": key(Int(num(1)), down: num(2) != 0)
    case "r": reset()
    default: say("err unknown command \(cmd)")
    }
}

say("ready trusted=\(AXIsProcessTrusted() ? 1 : 0)")
// Commands run on the main thread, which also owns the cursor timer; the reader thread hands
// them over one at a time and ends the process at end of input.
let reader = Thread {
    while let line = readLine() { DispatchQueue.main.sync { handle(line) } }
    DispatchQueue.main.sync { reset(); exit(0) }
}
reader.start()
let timer = Timer(timeInterval: 0.1, repeats: true) { _ in pollCursor() }
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()
