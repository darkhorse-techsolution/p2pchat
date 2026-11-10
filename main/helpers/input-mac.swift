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
// "ready" and errors go to stderr. Everything held is released at "r" and at end of input.
// Needs Accessibility access (the app asks for it before starting this helper).
import Foundation
import CoreGraphics
import ApplicationServices

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
func post(_ ev: CGEvent?) { guard let ev = ev else { return }; ev.flags = flags; ev.post(tap: .cghidEventTap) }
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

say("ready trusted=\(AXIsProcessTrusted() ? 1 : 0)")
while let line = readLine() {
    let p = line.split(separator: " ").map(String.init)
    guard let cmd = p.first else { continue }
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
reset()
