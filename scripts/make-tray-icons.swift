// Draws the menu bar icons into resources/: Ebbinghaus's forgetting curve. Memory fades, each review
// lifts it back up, and it fades more slowly each time (what Gloss's learner model and reviews do).
// Run: swift scripts/make-tray-icons.swift [preview-prefix]
// "Template" icons are black-on-transparent; macOS recolours them for light/dark menu bars.
// The dot at the end of the curve: hollow when idle, filled while recording, faded while paused.
import AppKit

enum Dot { case hollow, filled, faded }

func line(_ a: NSPoint, _ b: NSPoint, _ width: CGFloat) {
    let p = NSBezierPath()
    p.move(to: a)
    p.line(to: b)
    p.lineWidth = width
    p.lineCapStyle = .round
    p.stroke()
}

/** Drawn in an 18×18 point box (y goes up). */
func draw(_ dot: Dot) {
    NSColor.black.setStroke()
    let p = NSBezierPath()
    p.move(to: NSPoint(x: 1.6, y: 15.4))
    p.curve(to: NSPoint(x: 5.0, y: 5.0), controlPoint1: NSPoint(x: 2.0, y: 9.0), controlPoint2: NSPoint(x: 3.0, y: 5.4))
    p.line(to: NSPoint(x: 5.0, y: 15.4)) // a review
    p.curve(to: NSPoint(x: 10.2, y: 8.6), controlPoint1: NSPoint(x: 5.5, y: 10.6), controlPoint2: NSPoint(x: 7.6, y: 8.8))
    p.line(to: NSPoint(x: 10.2, y: 15.4)) // another review
    p.curve(to: NSPoint(x: 15.6, y: 11.8), controlPoint1: NSPoint(x: 11.0, y: 12.9), controlPoint2: NSPoint(x: 13.0, y: 12.0))
    p.lineWidth = 1.4
    p.lineJoinStyle = .round
    p.lineCapStyle = .round
    p.stroke()
    line(NSPoint(x: 1.5, y: 1.8), NSPoint(x: 16.5, y: 1.8), 1.3) // the time axis
    let c = NSPoint(x: 15.6, y: 11.8)
    switch dot {
    case .hollow:
        let r: CGFloat = 1.5
        let ring = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
        ring.lineWidth = 1.2
        ring.stroke()
    case .filled, .faded:
        let r: CGFloat = 1.9
        NSColor.black.withAlphaComponent(dot == .faded ? 0.45 : 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)).fill()
    }
}

func render(_ dot: Dot, size: CGFloat, scale: CGFloat, to path: String) {
    let px = Int(size * scale)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current!.cgContext.scaleBy(x: size / 18, y: size / 18)
    draw(dot)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let icons: [(String, Dot)] = [("trayIdleTemplate", .hollow), ("trayRecordingTemplate", .filled), ("trayPausedTemplate", .faded)]
if CommandLine.arguments.count > 1 {
    // Preview: each icon drawn big, for checking the shapes.
    for (i, (_, dot)) in icons.enumerated() { render(dot, size: 180, scale: 1, to: "\(CommandLine.arguments[1])-\(i).png") }
} else {
    for (name, dot) in icons {
        render(dot, size: 18, scale: 1, to: "resources/\(name).png")
        render(dot, size: 18, scale: 2, to: "resources/\(name)@2x.png")
    }
    print("icons written to resources/")
}
