// Synthesizes real OS-level mouse drags (CGEvent) so native window dragging is exercised.
// Usage:
//   mouse drag <x0> <y0> <x1> <y1> <durationMs> [holdMs] [cmd]
//     press at (x0,y0), hold holdMs (default 60), move linearly to (x1,y1) over durationMs
//     at ~120Hz, then release immediately (a "throw"). Coordinates are global points,
//     origin top-left of the primary display (same space as window.screenX/Y).
//   mouse click <x> <y>
//   mouse pos
import CoreGraphics
import Foundation

func post(_ type: CGEventType, _ p: CGPoint, flags: CGEventFlags = []) {
    let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
    e.flags = flags
    e.post(tap: .cghidEventTap)
}

func sleepMs(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

let a = CommandLine.arguments
switch a.count > 1 ? a[1] : "" {
case "drag":
    let x0 = Double(a[2])!, y0 = Double(a[3])!, x1 = Double(a[4])!, y1 = Double(a[5])!
    let dur = Double(a[6])!
    let hold = a.count > 7 ? Double(a[7])! : 60
    let flags: CGEventFlags = a.count > 8 && a[8] == "cmd" ? .maskCommand : []
    let start = CGPoint(x: x0, y: y0)
    post(.mouseMoved, start)
    sleepMs(80)
    post(.leftMouseDown, start, flags: flags)
    sleepMs(hold)
    let steps = max(1, Int(dur / 8.33))
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        post(.leftMouseDragged, CGPoint(x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t), flags: flags)
        sleepMs(dur / Double(steps))
    }
    post(.leftMouseUp, CGPoint(x: x1, y: y1), flags: flags)
case "dragpause":
    // mouse dragpause x0 y0 x1 y1 durMs pauseMs: fast drag, hold still pauseMs, release
    let x0 = Double(a[2])!, y0 = Double(a[3])!, x1 = Double(a[4])!, y1 = Double(a[5])!
    let dur = Double(a[6])!, pause = Double(a[7])!
    post(.mouseMoved, CGPoint(x: x0, y: y0)); sleepMs(80)
    post(.leftMouseDown, CGPoint(x: x0, y: y0)); sleepMs(60)
    let steps = max(1, Int(dur / 8.33))
    for i in 1...steps { let t = Double(i) / Double(steps); post(.leftMouseDragged, CGPoint(x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t)); sleepMs(dur / Double(steps)) }
    if pause > 0 { sleepMs(pause) }
    post(.leftMouseUp, CGPoint(x: x1, y: y1))
case "click":
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(.mouseMoved, p); sleepMs(50)
    post(.leftMouseDown, p); sleepMs(40)
    post(.leftMouseUp, p)
case "scroll":
    // mouse scroll <x> <y> <dx> <dy> <events>: a burst of pixel scroll events at (x,y)
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(.mouseMoved, p); sleepMs(80)
    // optional 7th arg: number of momentum events (deltas decaying x0.92 per 16ms frame)
    let sdx = Double(a[4])!, sdy = Double(a[5])!, n = Int(a[6])!
    let m = a.count > 7 ? Int(a[7])! : 0
    func scroll(_ x: Double, _ y: Double) {
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(y.rounded()), wheel2: Int32(x.rounded()), wheel3: 0)!
        e.location = p
        e.post(tap: .cghidEventTap)
    }
    for _ in 0..<n { scroll(sdx, sdy); sleepMs(12) }
    var k = 1.0
    for _ in 0..<m { k *= 0.92; scroll(sdx * k, sdy * k); sleepMs(16) }
case "phased":
    // mouse phased <x> <y> <dx> <dy> <fingerEvents> <momentumEvents>: real trackpad-style
    // gesture with NSEvent phases (began/changed/ended) then momentum (began/continue/end).
    let p = CGPoint(x: Double(a[2])!, y: Double(a[3])!)
    post(.mouseMoved, p); sleepMs(80)
    let sdx = Double(a[4])!, sdy = Double(a[5])!, n = Int(a[6])!, m = Int(a[7])!
    func ev(_ x: Double, _ y: Double, phase: Int64, momentum: Int64) {
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(y.rounded()), wheel2: Int32(x.rounded()), wheel3: 0)!
        e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
        e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
        e.location = p
        e.post(tap: .cghidEventTap)
    }
    ev(0, 0, phase: 1, momentum: 0); sleepMs(8)
    for _ in 0..<n { ev(sdx, sdy, phase: 2, momentum: 0); sleepMs(8) }
    ev(0, 0, phase: 4, momentum: 0); sleepMs(8)
    var k = 1.0
    for i in 0..<m { k *= 0.95; ev(sdx * k, sdy * k, phase: 0, momentum: i == 0 ? 1 : 2); sleepMs(8) }
    if m > 0 { ev(0, 0, phase: 0, momentum: 3) }
case "pos":
    let p = CGEvent(source: nil)!.location
    print("\(p.x) \(p.y)")
default:
    FileHandle.standardError.write("usage: mouse drag|click|pos ...\n".data(using: .utf8)!)
    exit(2)
}
