// Study Buddy Voice: turns speech into text with Apple's on-device speech recognition.
// A separate small program because macOS requires the app using the microphone and speech recognition
// to say why (see voice-Info.plist, embedded into this binary). The capture helper starts it as its own
// app ("vision-helper --disclaim"), so macOS asks permission for Study Buddy Voice itself.
// Audio is never written to disk and never leaves the Mac (requiresOnDeviceRecognition).
//
// JSON lines on stdin/stdout:
//   {"id":1,"cmd":"status"}             -> {"mic": "...", "speech": "...", "onDevice": true}
//   {"id":2,"cmd":"request"}            -> asks macOS for both permissions (shows the prompts)
//   {"id":3,"cmd":"start","locale":"en-US"}  -> microphone on, recognizing
//   {"id":4,"cmd":"stop"}               -> microphone off; returns {"text": "..."}
//   {"id":5,"cmd":"cancel"}             -> microphone off, text thrown away
// While listening it also sends {"event":"partial","text":"..."} and {"event":"level","value":0..1}.

import AVFoundation
import Foundation
import Speech

let outputLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
    outputLock.unlock()
}

func micStatus() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not-asked"
    }
}

func speechStatus() -> String {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "not-asked"
    }
}

enum VoiceError: Error, CustomStringConvertible {
    case noPermission(String), unavailable(String)
    var description: String {
        switch self {
        case .noPermission(let s), .unavailable(let s): return s
        }
    }
}

final class Listener: @unchecked Sendable { // used only from the main thread and the audio callback
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var text = ""
    private var finished: CheckedContinuation<Void, Never>?
    private var isFinal = false
    private var lastLevel = Date.distantPast

    func start(locale: String) throws {
        stopAudio()
        guard micStatus() == "granted" else { throw VoiceError.noPermission("Microphone permission is needed.") }
        guard speechStatus() == "granted" else { throw VoiceError.noPermission("Speech Recognition permission is needed.") }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
            throw VoiceError.unavailable("Speech recognition isn't available for \(locale).")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            throw VoiceError.unavailable("On-device speech recognition isn't set up for \(locale). Turn on Dictation in System Settings → Keyboard once, then try again.")
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true // audio never leaves the Mac
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            req.append(buffer)
            self?.reportLevel(buffer)
        }
        text = ""
        isFinal = false
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.text = result.bestTranscription.formattedString
                send(["event": "partial", "text": self.text])
                if result.isFinal { self.markFinished() }
            }
            if error != nil { self.markFinished() }
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        self.request = req
    }

    /// Roughly how loud the microphone is (0–1), about 12 times a second, for the listening indicator.
    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard Date().timeIntervalSince(lastLevel) > 0.08, let data = buffer.floatChannelData?[0] else { return }
        lastLevel = Date()
        let n = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<n { sum += data[i] * data[i] }
        let rms = n > 0 ? sqrt(sum / Float(n)) : 0
        send(["event": "level", "value": min(1, Double(rms) * 8)])
    }

    private func markFinished() {
        isFinal = true
        finished?.resume()
        finished = nil
    }

    private func stopAudio() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }

    /// Microphone off; waits briefly for the last words to be recognized.
    func stop() async -> String {
        stopAudio()
        request?.endAudio()
        if !isFinal && task != nil {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                finished = c
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.markFinished() }
            }
        }
        task?.cancel()
        task = nil
        request = nil
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        stopAudio()
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        text = ""
    }
}

let listener = Listener()

@MainActor
func handle(_ req: [String: Any]) async -> [String: Any] {
    let cmd = req["cmd"] as? String ?? ""
    do {
        switch cmd {
        case "status":
            let onDevice = SFSpeechRecognizer(locale: Locale(identifier: req["locale"] as? String ?? "en-US"))?.supportsOnDeviceRecognition ?? false
            return ["ok": true, "mic": micStatus(), "speech": speechStatus(), "onDevice": onDevice]
        case "request":
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            _ = await withCheckedContinuation { (c: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
            }
            return ["ok": true, "mic": micStatus(), "speech": speechStatus()]
        case "start":
            try listener.start(locale: req["locale"] as? String ?? "en-US")
            return ["ok": true]
        case "stop":
            return ["ok": true, "text": await listener.stop()]
        case "cancel":
            listener.cancel()
            return ["ok": true]
        default:
            return ["ok": false, "error": "unknown command: \(cmd)"]
        }
    } catch {
        return ["ok": false, "error": "\(error)"]
    }
}

Task { @MainActor in
    do {
        for try await line in FileHandle.standardInput.bytes.lines {
            guard let data = line.data(using: .utf8),
                  let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            var res = await handle(req)
            res["id"] = req["id"] ?? NSNull()
            send(res)
        }
    } catch {}
    listener.cancel() // stdin closed: microphone off, quit
    exit(0)
}
dispatchMain()
