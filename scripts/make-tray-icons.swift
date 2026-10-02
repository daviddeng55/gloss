// Draws the menu bar icons from Apple's SF Symbols into resources/.
// Run: swift scripts/make-tray-icons.swift
// "Template" icons are black-on-transparent; macOS recolours them for light/dark menu bars.
import AppKit

func render(_ symbol: String, color: NSColor, size: CGFloat, scale: CGFloat, to path: String) {
    let config = NSImage.SymbolConfiguration(pointSize: size * 0.8, weight: .regular)
    guard let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) else {
        fatalError("no symbol \(symbol)")
    }
    let px = Int(size * scale)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = img.size
    let r = NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height)
    img.draw(in: r)
    color.set()
    r.fill(using: .sourceAtop)   // tint the symbol
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

for (name, symbol, color) in [
    ("trayIdleTemplate", "book.closed", NSColor.black),
    ("trayPausedTemplate", "pause.circle", NSColor.black),
    ("trayRecording", "record.circle.fill", NSColor.systemRed),
] {
    render(symbol, color: color, size: 18, scale: 1, to: "resources/\(name).png")
    render(symbol, color: color, size: 18, scale: 2, to: "resources/\(name)@2x.png")
}
print("icons written to resources/")
