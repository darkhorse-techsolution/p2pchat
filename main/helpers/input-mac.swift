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
//
// Started as `p2pchat-input grab ...` it does the opposite, on the Mac of whoever drives a contact's
// screen: it takes the key events off this Mac and reports them (see "grab mode" below).
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

// --- grab mode: the keys of the viewer's Mac ---------------------------------------------------
// `p2pchat-input grab KEY:MODS ...` runs on the Mac of someone who drives a contact's screen in full
// screen. For as long as it runs it takes the key events off this Mac, ⌘Tab, Spotlight and Mission
// Control with them, and writes them to stdout instead, for the app to send over:
//   k CODE 1|0 [1]   a key went down / up (CGKeyCode, the modifiers too); a last field of 1 marks an auto-repeat
//   r                one of the app's own hotkeys went by: it is left to this Mac, and what was sent of it is let go over there
//   x N              which one: the N-th argument (from 0)
// The arguments name those hotkeys: CGKeyCode, a colon, the modifiers (1 shift, 2 control, 4 option, 8 command).
// It holds the keyboard only while the app that started it is the frontmost one. It lets go and ends
// when it has not read "h" from stdin for 3 s (an app that hangs must not leave the keyboard dead), at
// "q", and at end of input. Needs Accessibility access, like the posting mode. Nothing it reads is kept
// or written anywhere but that one line per key.
var grabTap: CFMachPort? = nil
var grabBeat = Date().timeIntervalSince1970
var grabPass: [(code: Int64, mods: Int)] = []
var grabDown = Set<Int64>()      // reported as down, not yet as up
var grabPassed = Set<Int64>()    // the key of a hotkey that went through on its way down: its way up goes through as well
var grabNoted = false
let grabApp = getppid()
// which physical modifier key a flagsChanged event is about: the device-dependent bits of its flags
let DEVBIT: [Int64: UInt64] = [59: 0x1, 56: 0x2, 60: 0x4, 55: 0x8, 54: 0x10, 58: 0x20, 61: 0x40, 62: 0x2000]

func emit(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func grabRelease() { for c in grabDown { emit("k \(c) 0") }; grabDown.removeAll() }
func grabMods(_ f: CGEventFlags) -> Int { (f.contains(.maskShift) ? 1 : 0) | (f.contains(.maskControl) ? 2 : 0) | (f.contains(.maskAlternate) ? 4 : 0) | (f.contains(.maskCommand) ? 8 : 0) }
func grabEnd(_ why: String) -> Never {
    if let t = grabTap { CGEvent.tapEnable(tap: t, enable: false) }
    grabRelease(); say("grab end: \(why)"); exit(0)
}

func grabEvent(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    let pass = Unmanaged.passUnretained(event)
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { if let t = grabTap { CGEvent.tapEnable(tap: t, enable: true) }; return pass }
    guard type == .keyDown || type == .keyUp || type == .flagsChanged else { return pass }
    // only while the app this helper belongs to is the one in front: in any other app the keys are that app's
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
    if front != grabApp {
        if !grabNoted { grabNoted = true; say("grab: the app is not in front (front \(front), app \(grabApp)): keys stay here") }
        grabRelease(); return pass
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    if type == .flagsChanged {
        let down: Bool
        if let bit = DEVBIT[code] { down = event.flags.rawValue & bit != 0 }
        else if code == 63 { down = event.flags.contains(.maskSecondaryFn) }
        else { return pass }                                   // Caps Lock, and anything unknown, stays here
        if down { if !grabDown.contains(code) { grabDown.insert(code); emit("k \(code) 1") } }
        else if grabDown.remove(code) != nil { emit("k \(code) 0") }
        return nil
    }
    if type == .keyDown {
        let mods = grabMods(event.flags)
        if let i = grabPass.firstIndex(where: { $0.code == code && $0.mods == mods }) { grabPassed.insert(code); grabDown.removeAll(); emit("r"); emit("x \(i)"); return pass }
        let rep = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        grabDown.insert(code)
        emit(rep ? "k \(code) 1 1" : "k \(code) 1")
        return nil
    }
    if grabPassed.remove(code) != nil { return pass }
    if grabDown.remove(code) != nil { emit("k \(code) 0"); return nil }
    return pass                                                // it went down before the grab began: its way up belongs to whoever got the way down
}

func runGrab(_ args: [String]) -> Never {
    for a in args { let p = a.split(separator: ":"); if p.count == 2, let c = Int64(p[0]), let m = Int(p[1]) { grabPass.append((code: c, mods: m)) } }
    let mask = CGEventMask((1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue))
    var point = "hid"
    var tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: grabEvent, userInfo: nil)
    if tap == nil { point = "session"; tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: grabEvent, userInfo: nil) }
    guard let t = tap else { say("err tap trusted=\(AXIsProcessTrusted() ? 1 : 0)"); exit(3) }
    grabTap = t
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0), .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    say("ready grab tap=\(point) hotkeys=\(grabPass.count)")
    let reader = Thread {
        while let line = readLine() { DispatchQueue.main.sync { if line == "h" { grabBeat = Date().timeIntervalSince1970 } else if line == "q" { grabEnd("asked") } } }
        DispatchQueue.main.sync { grabEnd("end of input") }
    }
    reader.start()
    let watch = Timer(timeInterval: 0.5, repeats: true) { _ in if Date().timeIntervalSince1970 - grabBeat > 3 { grabEnd("no beat") } }
    RunLoop.main.add(watch, forMode: .common)
    RunLoop.main.run()
    exit(0)
}

if CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "grab" { runGrab(Array(CommandLine.arguments.dropFirst(2))) }

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
