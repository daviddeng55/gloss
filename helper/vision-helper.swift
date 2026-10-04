// vision-helper: a tiny long-running process that captures the screen and reads
// text from it with Apple's Vision framework. Node talks to it over stdin/stdout,
// one JSON object per line. Screenshots stay in memory and are never written to disk.
//
// Requests (one per line on stdin):
//   {"id":1,"cmd":"permission"}                  -> is Screen Recording granted?
//   {"id":2,"cmd":"requestPermission"}           -> ask macOS to show the permission prompt
//   {"id":3,"cmd":"windows"}                     -> on-screen windows, front to back
//   {"id":4,"cmd":"capture","windowId":N, ...}   -> capture, compare, maybe read text
//   {"id":5,"cmd":"ocrFile","path":"...", ...}   -> read text from an image file (for testing)
//   {"id":6,"cmd":"image","rect":{x,y,w,h}}      -> JPEG (base64) of part of the last image read, for the math pass
//   {"id":7,"cmd":"forgetImage"}                 -> drop the last image from memory
//   {"id":8,"cmd":"snap","x":..,"y":..,"rect":{x,y,w,h},...}  -> JPEG of a screen region (global points)
//
// Build: npm run build:helper

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// MARK: - JSON in/out

let outputLock = NSLock()

/// Writes one JSON line. Replies can come from different threads, so writes are locked.
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
          let line = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    outputLock.unlock()
}


// MARK: - Windows

struct WindowInfo {
    let id: CGWindowID
    let app: String
    let bundleId: String
    let pid: pid_t
    let title: String
    let width: Int
    let height: Int
}

/// Normal on-screen windows, front to back. The first one belongs to the app you're working in
/// (but may be a toolbar strip, e.g. Chrome in full screen; Node picks the real window).
/// We read the live window order from the window server rather than asking NSWorkspace for
/// the "frontmost application": in a command-line program NSWorkspace never refreshes, so it
/// keeps reporting whichever app was in front when the helper started.
/// Window titles are only visible once Screen Recording permission is granted.
func windowList() -> [WindowInfo] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    var bundleIds: [pid_t: String] = [:]
    var out: [WindowInfo] = []
    for info in list {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let id = info[kCGWindowNumber as String] as? CGWindowID,
              let pid = info[kCGWindowOwnerPID as String] as? pid_t else { continue }
        let bounds = info[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
        if (bounds["Width"] ?? 0) < 100 || (bounds["Height"] ?? 0) < 100 { continue }
        if bundleIds[pid] == nil {
            bundleIds[pid] = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        }
        out.append(WindowInfo(
            id: id,
            app: info[kCGWindowOwnerName as String] as? String ?? "",
            bundleId: bundleIds[pid] ?? "",
            pid: pid,
            title: info[kCGWindowName as String] as? String ?? "",
            width: Int(bounds["Width"] ?? 0),
            height: Int(bounds["Height"] ?? 0)))
    }
    return out
}

func windowDict(_ w: WindowInfo) -> [String: Any] {
    ["windowId": Int(w.id), "app": w.app, "bundleId": w.bundleId, "pid": Int(w.pid), "title": w.title,
     "width": w.width, "height": w.height]
}

// MARK: - Screen capture (ScreenCaptureKit, in memory)

enum HelperError: Error, CustomStringConvertible {
    case noPermission, noWindow, noDisplay, badImage(String), noImage
    var description: String {
        switch self {
        case .noPermission: return "Screen Recording permission is not granted"
        case .noWindow: return "That window is no longer on screen"
        case .noDisplay: return "No display found"
        case .badImage(let p): return "Could not read image: \(p)"
        case .noImage: return "No image to crop"
        }
    }
}

/// mode "window": just one window (no menu bar, Dock or other windows, so less noise).
/// mode "display": the whole display that window is on, minus any windows in `exclude`.
func capture(mode: String, windowId: CGWindowID, exclude: Set<CGWindowID>) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.captureResolution = .best
    let win = content.windows.first(where: { $0.windowID == windowId })

    if mode == "window" {
        guard let win else { throw HelperError.noWindow }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int(win.frame.width * scale)
        config.height = Int(win.frame.height * scale)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    // Pick the display containing the window's centre, else the first one.
    var display = content.displays.first
    if let win {
        let centre = CGPoint(x: win.frame.midX, y: win.frame.midY)
        display = content.displays.first(where: { $0.frame.contains(centre) }) ?? display
    }
    guard let display else { throw HelperError.noDisplay }
    let hidden = content.windows.filter { exclude.contains($0.windowID) }
    let filter = SCContentFilter(display: display, excludingWindows: hidden)
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

// MARK: - Cropping (math pass)

/// The last image whose text was read. Kept in memory only (never on disk) so the math pass can
/// crop the part with new math; replaced on the next read and gone when the helper exits.
var lastImage: CGImage?

/// `rect` is in fractions of the image, top-left origin (same as text block boxes).
func jpegBase64(_ image: CGImage, rect: [String: Double]?, maxWidth: Int) throws -> [String: Any] {
    var img = image
    if let r = rect, let x = r["x"], let y = r["y"], let w = r["w"], let h = r["h"] {
        let W = Double(image.width), H = Double(image.height)
        let crop = CGRect(x: x * W, y: y * H, width: w * W, height: h * H).integral
            .intersection(CGRect(x: 0, y: 0, width: W, height: H))
        guard !crop.isEmpty, let c = image.cropping(to: crop) else { throw HelperError.noImage }
        img = c
    }
    if img.width > maxWidth {
        let scale = Double(maxWidth) / Double(img.width)
        let size = (w: maxWidth, h: max(1, Int(Double(img.height) * scale)))
        guard let ctx = CGContext(data: nil, width: size.w, height: size.h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw HelperError.noImage }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: size.w, height: size.h))
        guard let scaled = ctx.makeImage() else { throw HelperError.noImage }
        img = scaled
    }
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw HelperError.noImage
    }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HelperError.noImage }
    return ["jpeg": (data as Data).base64EncodedString(), "width": img.width, "height": img.height]
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

        case "windows":
            return ["ok": true, "windows": windowList().map(windowDict)]

        case "capture":
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.noPermission }
            let mode = req["mode"] as? String ?? "window"
            let threshold = req["threshold"] as? Double ?? 0.02
            let force = req["force"] as? Bool ?? false
            guard let windowId = req["windowId"] as? Int else { throw HelperError.noWindow }
            let exclude = Set((req["excludeWindowIds"] as? [Int] ?? []).map { CGWindowID($0) })
            let t0 = Date()
            let image = try await capture(mode: mode, windowId: CGWindowID(windowId), exclude: exclude)
            let thumb = thumbnail(image)
            let ratio = changeRatio(thumb, lastReadThumb)
            var out: [String: Any] = ["ok": true, "changeRatio": ratio,
                                      "width": image.width, "height": image.height]
            if !force && ratio < threshold {
                out["skipped"] = true
                return out
            }
            let blocks = try await recognize(image, OCROptions(req))
            lastReadThumb = thumb
            lastImage = image
            out["skipped"] = false
            out["blocks"] = blocks
            out["ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            return out   // nothing was written to disk; `lastImage` is replaced on the next read

        case "ocrFile":
            let path = req["path"] as? String ?? ""
            guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { throw HelperError.badImage(path) }
            let t0 = Date()
            let blocks = try await recognize(image, OCROptions(req))
            lastImage = image
            return ["ok": true, "blocks": blocks, "width": image.width, "height": image.height,
                    "ms": Int(Date().timeIntervalSince(t0) * 1000)]

        case "image":
            guard let img = lastImage else { throw HelperError.noImage }
            let out = try jpegBase64(img, rect: req["rect"] as? [String: Double], maxWidth: req["maxWidth"] as? Int ?? 1400)
            return ["ok": true].merging(out) { a, _ in a }

        case "snap":
            // Capture the display under (x, y) — global points, top-left origin — leaving out windows of
            // `excludePids` (Study Buddy's own overlay and popups) and `excludeWindowIds` (never-record
            // windows), then crop to `rect` (global points). Memory only, like every capture.
            guard CGPreflightScreenCaptureAccess() else { throw HelperError.noPermission }
            let point = CGPoint(x: req["x"] as? Double ?? 0, y: req["y"] as? Double ?? 0)
            let r = req["rect"] as? [String: Double] ?? [:]
            let excludeIds = Set((req["excludeWindowIds"] as? [Int] ?? []).map { CGWindowID($0) })
            let excludePids = Set((req["excludePids"] as? [Int] ?? []).map { pid_t($0) })
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.frame.contains(point) }) ?? content.displays.first
            else { throw HelperError.noDisplay }
            let hidden = content.windows.filter {
                excludeIds.contains($0.windowID) || excludePids.contains($0.owningApplication?.processID ?? -1)
            }
            let filter = SCContentFilter(display: display, excludingWindows: hidden)
            let config = SCStreamConfiguration()
            config.showsCursor = false
            config.captureResolution = .best
            let scale = CGFloat(filter.pointPixelScale)
            config.width = Int(CGFloat(display.width) * scale)
            config.height = Int(CGFloat(display.height) * scale)
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let f = display.frame
            let frac: [String: Double] = [
                "x": ((r["x"] ?? f.minX) - f.minX) / f.width, "y": ((r["y"] ?? f.minY) - f.minY) / f.height,
                "w": (r["w"] ?? f.width) / f.width, "h": (r["h"] ?? f.height) / f.height,
            ]
            let out = try jpegBase64(image, rect: frac, maxWidth: req["maxWidth"] as? Int ?? 1600)
            return ["ok": true].merging(out) { a, _ in a }

        case "forgetImage":
            lastImage = nil
            return ["ok": true]

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
