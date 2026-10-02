// vision-helper: a tiny long-running process that captures the screen and reads
// text from it with Apple's Vision framework. Node talks to it over stdin/stdout,
// one JSON object per line. Screenshots stay in memory and are never written to disk.
//
// Requests (one per line on stdin):
//   {"id":1,"cmd":"permission"}                  -> is Screen Recording granted?
//   {"id":2,"cmd":"requestPermission"}           -> ask macOS to show the permission prompt
//   {"id":3,"cmd":"frontmost"}                   -> frontmost app + window title
//   {"id":4,"cmd":"capture", ...options}         -> capture, compare, maybe read text
//   {"id":5,"cmd":"ocrFile","path":"...", ...}   -> read text from an image file (for testing)
//
// Build: npm run build:helper

import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

// MARK: - JSON in/out

func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

// MARK: - Frontmost window

struct FrontWindow {
    let app: String
    let bundleId: String
    let pid: pid_t
    let windowId: CGWindowID?
    let title: String
}

/// Finds the frontmost app and its topmost normal window.
/// CGWindowList returns windows front-to-back, so the first match is the one on top.
/// Window titles are only visible once Screen Recording permission is granted.
func frontWindow() -> FrontWindow? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
              (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
        let bounds = info[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        if (bounds["Width"] ?? 0) < 100 || (bounds["Height"] ?? 0) < 100 { continue }
        return FrontWindow(
            app: app.localizedName ?? "",
            bundleId: app.bundleIdentifier ?? "",
            pid: pid,
            windowId: info[kCGWindowNumber as String] as? CGWindowID,
            title: info[kCGWindowName as String] as? String ?? "")
    }
    return FrontWindow(app: app.localizedName ?? "", bundleId: app.bundleIdentifier ?? "",
                       pid: pid, windowId: nil, title: "")
}

func frontDict(_ w: FrontWindow?) -> [String: Any] {
    guard let w else { return ["app": "", "bundleId": "", "title": ""] }
    return ["app": w.app, "bundleId": w.bundleId, "title": w.title]
}

// MARK: - Screen capture (ScreenCaptureKit, in memory)

enum HelperError: Error, CustomStringConvertible {
    case noPermission, noWindow, noDisplay, badImage(String)
    var description: String {
        switch self {
        case .noPermission: return "Screen Recording permission is not granted"
        case .noWindow: return "No capturable window in the frontmost app"
        case .noDisplay: return "No display found"
        case .badImage(let p): return "Could not read image: \(p)"
        }
    }
}

/// mode "window": just the frontmost window (no menu bar or Dock, so less noise).
/// mode "display": the whole display that the frontmost window is on.
func capture(mode: String, front: FrontWindow?) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.captureResolution = .best

    if mode == "window" {
        guard let id = front?.windowId,
              let win = content.windows.first(where: { $0.windowID == id }) else { throw HelperError.noWindow }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(win.frame.width * scale)
        config.height = Int(win.frame.height * scale)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    // Pick the display containing the front window's centre, else the first one.
    var display = content.displays.first
    if let id = front?.windowId, let win = content.windows.first(where: { $0.windowID == id }) {
        let centre = CGPoint(x: win.frame.midX, y: win.frame.midY)
        display = content.displays.first(where: { $0.frame.contains(centre) }) ?? display
    }
    guard let display else { throw HelperError.noDisplay }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let scale = CGFloat(filter.pointPixelScale)
    config.width = Int(CGFloat(display.width) * scale)
    config.height = Int(CGFloat(display.height) * scale)
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
}

// MARK: - Change detection

/// Shrinks the image to a fixed 96×96 grayscale thumbnail. Comparing two thumbnails
/// pixel by pixel is a cheap way to tell "the page scrolled" from "a cursor blinked".
let thumbSide = 96

func thumbnail(_ image: CGImage) -> [UInt8] {
    var pixels = [UInt8](repeating: 0, count: thumbSide * thumbSide)
    pixels.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(data: buf.baseAddress, width: thumbSide, height: thumbSide,
                                  bitsPerComponent: 8, bytesPerRow: thumbSide,
                                  space: CGColorSpaceCreateDeviceGray(),
                                  bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: thumbSide, height: thumbSide))
    }
    return pixels
}

/// Fraction (0–1) of thumbnail pixels whose brightness changed noticeably.
func changeRatio(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return 1 }
    var changed = 0
    for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > 24 { changed += 1 }
    return Double(changed) / Double(a.count)
}

// MARK: - Text recognition

struct OCROptions {
    var engine = "lines"            // "lines" (VNRecognizeTextRequest) or "document" (macOS 26 paragraphs)
    var languageCorrection = true   // spell-check-like fixing; can mangle math
    var languages = ["en-US"]

    init(_ req: [String: Any]) {
        if let e = req["engine"] as? String { engine = e }
        if let lc = req["languageCorrection"] as? Bool { languageCorrection = lc }
        if let l = req["languages"] as? [String], !l.isEmpty { languages = l }
    }
}

/// Each block: text, confidence (0–1) and a box in top-left-origin fractions of the image.
func box(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": 1 - r.maxY, "w": r.width, "h": r.height]
}

func recognizeLines(_ image: CGImage, _ opts: OCROptions) throws -> [[String: Any]] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = opts.languageCorrection
    request.recognitionLanguages = opts.languages
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { obs in
        guard let top = obs.topCandidates(1).first else { return nil }
        return ["text": top.string, "confidence": Double(top.confidence), "box": box(obs.boundingBox)]
    }
}

@available(macOS 26.0, *)
func recognizeDocument(_ image: CGImage, _ opts: OCROptions) async throws -> [[String: Any]] {
    var request = RecognizeDocumentsRequest()
    request.textRecognitionOptions.useLanguageCorrection = opts.languageCorrection
    request.textRecognitionOptions.automaticallyDetectLanguage = false
    request.textRecognitionOptions.recognitionLanguages = opts.languages.map { Locale.Language(identifier: $0) }
    let observations = try await request.perform(on: image, orientation: nil)
    var blocks: [[String: Any]] = []
    for doc in observations {
        for para in doc.document.paragraphs {
            let lines = para.lines
            let conf = lines.isEmpty ? 0 : lines.map { Double($0.confidence) }.reduce(0, +) / Double(lines.count)
            // Keep line breaks inside a paragraph; math and code rely on them.
            let text = lines.isEmpty ? para.transcript : lines.map(\.transcript).joined(separator: "\n")
            blocks.append(["text": text, "confidence": conf, "box": box(para.boundingRegion.boundingBox.cgRect)])
        }
    }
    return blocks
}

func recognize(_ image: CGImage, _ opts: OCROptions) async throws -> [[String: Any]] {
    if opts.engine == "document", #available(macOS 26.0, *) {
        return try await recognizeDocument(image, opts)
    }
    return try recognizeLines(image, opts)
}

// MARK: - Commands

/// Thumbnail of the last capture that was actually read. Comparing against the last
/// *read* capture (not the last capture) means slow scrolling still adds up to a change.
var lastReadThumb: [UInt8] = []

func handle(_ req: [String: Any]) async -> [String: Any] {
    let cmd = req["cmd"] as? String ?? ""
    do {
        switch cmd {
        case "permission":
            return ["ok": true, "granted": CGPreflightScreenCaptureAccess()]

        case "requestPermission":
            return ["ok": true, "granted": CGRequestScreenCaptureAccess()]

        case "frontmost":
            return ["ok": true].merging(frontDict(frontWindow())) { a, _ in a }

        case "capture":
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.noPermission }
            let mode = req["mode"] as? String ?? "window"
            let threshold = req["threshold"] as? Double ?? 0.02
            let force = req["force"] as? Bool ?? false
            let front = frontWindow()
            let t0 = Date()
            let image = try await capture(mode: mode, front: front)
            let thumb = thumbnail(image)
            let ratio = changeRatio(thumb, lastReadThumb)
            var out: [String: Any] = ["ok": true, "changeRatio": ratio,
                                      "width": image.width, "height": image.height]
            out.merge(frontDict(front)) { a, _ in a }
            if !force && ratio < threshold {
                out["skipped"] = true
                return out
            }
            let blocks = try await recognize(image, OCROptions(req))
            lastReadThumb = thumb
            out["skipped"] = false
            out["blocks"] = blocks
            out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            return out   // `image` goes out of scope here; nothing was written to disk

        case "ocrFile":
            let path = req["path"] as? String ?? ""
            guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw HelperError.badImage(path) }
            let t0 = Date()
            let blocks = try await recognize(image, OCROptions(req))
            return ["ok": true, "blocks": blocks, "width": image.width, "height": image.height,
                    "ms": Int(Date().timeIntervalSince(t0) * 1000)]

        case "resetChange":
            lastReadThumb = []
            return ["ok": true]

        default:
            return ["ok": false, "error": "unknown command: \(cmd)"]
        }
    } catch {
        return ["ok": false, "error": "\(error)"]
    }
}

// Read requests one line at a time and answer them in order.
Task {
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            guard let data = line.data(using: .utf8),
                  let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                send(["ok": false, "error": "bad JSON"])
                continue
            }
            var res = await handle(req)
            res["id"] = req["id"] ?? NSNull()
            send(res)
        }
    } catch {
        send(["ok": false, "error": "stdin: \(error)"])
    }
    exit(0)   // stdin closed: Node is done with us
}
dispatchMain()
