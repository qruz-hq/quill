// flow-stt — on-device speech recognition helper for the Flow clone.
// Protocol: newline-delimited JSON on stdout; bare commands on stdin.
//   stdin : start | stop | cancel | quit
//   stdout: {"type":"ready"} {"type":"partial","text":…} {"type":"final","text":…}
//           {"type":"level","value":0.0–1.0} {"type":"error","message":…}

import Foundation
import AVFoundation
import AppKit
import CoreGraphics
import CoreAudio

let stdoutQueue = DispatchQueue(label: "stdout")

/// Everything the recogniser does, appended to a file. A Finder-launched app
/// has no visible stdout, so this is the only way to see what happened.
let logURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Logs/Quill-stt.log")

func logLine(_ text: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(text)\n"
    stdoutQueue.async {
        guard let data = line.data(using: .utf8) else { return }
        let fm = FileManager.default
        let dir = logURL.deletingLastPathComponent()
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile(); h.write(data); try? h.close()
        } else {
            try? data.write(to: logURL)
        }
    }
}

func emit(_ payload: [String: Any]) {
    stdoutQueue.async {
        guard var data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        data.append(0x0A)
        data.withUnsafeBytes { raw in
            var off = 0
            while off < raw.count {
                let n = write(1, raw.baseAddress!.advanced(by: off), raw.count - off)
                if n <= 0 { break }
                off += n
            }
        }
    }
}

/// Records microphone audio and transcribes it in one batch with whisper.cpp.
///
/// Deliberately NOT streaming. Apple's streaming recogniser forced segment
/// rollover, pause detection and hypothesis-restart heuristics, and every one
/// of those was a source of bugs. Recording to a buffer and transcribing once
/// on release removes that entire class of problem.
final class Recognizer {
    private let engine = AVAudioEngine()
    private var samples: [Float] = []          // 16 kHz mono, whisper's native rate
    private let samplesLock = NSLock()
    private var converter: AVAudioConverter?
    private var running = false
    private var tapInstalled = false
    /// Interim transcription while the user is still speaking, so the bar can
    /// show words appearing instead of a silent wait. Greedy decoding only —
    /// ~20x faster than the beam search used for the final pass.
    private var partialTimer: DispatchSourceTimer?
    private var partialInFlight = false
    private static let partialInterval: TimeInterval = 1.5

    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: 16_000, channels: 1, interleaved: false)!

    /// Bundled next to the app binary: Contents/Resources/whisper/
    private var whisperDir: URL {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        return exe.deletingLastPathComponent()          // Contents/MacOS
                  .deletingLastPathComponent()          // Contents
                  .appendingPathComponent("Resources/whisper")
    }

    func start() {
        guard !running else { return }
        samplesLock.lock(); samples.removeAll(); samplesLock.unlock()

        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else {
            emit(["type": "error", "message": "no input device"]); return
        }
        converter = AVAudioConverter(from: inFormat, to: target)

        if !tapInstalled {
            input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
                self?.accumulate(buffer)
                self?.emitLevel(buffer)
            }
            tapInstalled = true
        }

        engine.prepare()
        do {
            try engine.start()
            running = true
            Ducker.duck()
            startPartials()
            emit(["type": "started"])
            logLine("=== recording started ===")
        } catch {
            emit(["type": "error", "message": "engine: \(error.localizedDescription)"])
            removeTap()
        }
    }

    /// Resample whatever the device gives us down to 16 kHz mono and keep it.
    private func accumulate(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }

        var supplied = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        guard err == nil, out.frameLength > 0, let ch = out.floatChannelData?[0] else { return }

        samplesLock.lock()
        samples.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
        samplesLock.unlock()
    }

    private func emitLevel(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        for i in 0..<n { sum += channel[i] * channel[i] }
        let db = 20 * log10(max(sqrt(sum / Float(n)), 1e-7))
        let norm = (db + 55) / 55
        emit(["type": "level", "value": Double(max(0, min(1, norm)))])
    }

    /// Re-transcribes everything captured so far, cheaply, on a timer.
    private func startPartials() {
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + Recognizer.partialInterval,
                       repeating: Recognizer.partialInterval)
        timer.setEventHandler { [weak self] in
            guard let self, self.running, !self.partialInFlight else { return }
            self.samplesLock.lock(); let audio = self.samples; self.samplesLock.unlock()
            guard Double(audio.count) / 16_000 >= 1.0 else { return }

            self.partialInFlight = true
            defer { self.partialInFlight = false }
            if let text = self.transcribe(audio, fast: true), !text.isEmpty, self.running {
                emit(["type": "partial", "text": text])
            }
        }
        timer.resume()
        partialTimer = timer
    }

    private func stopPartials() {
        partialTimer?.cancel()
        partialTimer = nil
    }

    func stop() {
        guard running else { emit(["type": "final", "text": ""]); return }
        running = false
        stopPartials()
        Ducker.restore()
        removeTap()

        samplesLock.lock(); let audio = samples; samples.removeAll(); samplesLock.unlock()
        let seconds = Double(audio.count) / 16_000

        // A mic-denied app is handed digital silence, not an error, so the only
        // way to tell "permission missing" from "you said nothing" is the signal.
        var peak: Float = 0
        for v in audio { peak = max(peak, abs(v)) }
        logLine("=== recording stopped (\(String(format: "%.1f", seconds))s, peak \(String(format: "%.4f", peak))) ===")

        if peak < 0.0005 && seconds > 0.5 {
            logLine("audio is digital silence — microphone permission is almost certainly missing")
            emit(["type": "error", "message": "No audio from the microphone. Allow Quill under Privacy & Security > Microphone."])
            emit(["type": "final", "text": ""])
            return
        }

        // Too short to contain speech.
        guard seconds > 0.3 else { emit(["type": "final", "text": ""]); return }

        guard !modelPath.isEmpty, FileManager.default.fileExists(atPath: modelPath) else {
            emit(["type": "error", "message": "No speech model installed - pick one in Settings"])
            emit(["type": "final", "text": ""])
            logLine("transcribe aborted: no model at \"\(modelPath)\"")
            return
        }
        emit(["type": "transcribing"])
        Task.detached { [weak self] in
            guard let self else { return }
            let text = self.transcribe(audio) ?? ""
            logLine("whisper: \"\(text)\"")
            emit(["type": "final", "text": text])
        }
    }

    /// Writes a 16-bit mono WAV and runs whisper-cli over it.
    private func transcribe(_ audio: [Float], fast: Bool = false) -> String? {
        let wav = FileManager.default.temporaryDirectory
            .appendingPathComponent("flow-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: wav) }
        guard writeWav(audio, to: wav) else { return nil }

        let dir = whisperDir
        // Interim passes skip language detection: the final pass settles it.
        let chosen = fast ? (languages.first ?? "auto") : resolveLanguage(for: wav, in: dir)

        let proc = Process()
        proc.executableURL = dir.appendingPathComponent("whisper-cli")
        proc.arguments = [
            "-m", modelPath,
            "-f", wav.path,
            "-nt",            // no timestamps
            "--no-prints",
            "-t", "8",
            "-l", chosen
        ] + (fast ? ["-bo", "1", "-bs", "1"] : [])
        // The dylibs sit beside the binary.
        var env = ProcessInfo.processInfo.environment
        env["DYLD_LIBRARY_PATH"] = dir.path
        proc.environment = env

        let pipe = Pipe(), errPipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = errPipe
        let started = Date()
        do { try proc.run() } catch {
            logLine("whisper spawn failed: \(error.localizedDescription)"); return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()

        if proc.terminationStatus != 0 {
            let e = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            logLine("whisper exit \(proc.terminationStatus): \(e.prefix(200))")
            return nil
        }
        let text = (String(data: data, encoding: .utf8) ?? "")
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("[") }
            .joined(separator: " ")
        if !fast {
            logLine("whisper took \(Int(Date().timeIntervalSince(started) * 1000))ms for \(String(format: "%.1f", Double(audio.count)/16000))s audio")
        }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// With a single language there is nothing to decide. With several, run a
    /// detection pass and snap the answer to the chosen set — unconstrained
    /// auto-detect will happily return German for a short French phrase.
    private func resolveLanguage(for wav: URL, in dir: URL) -> String {
        let set = languages.filter { !$0.isEmpty }
        if set.contains("auto") || set.isEmpty { return "auto" }
        if set.count == 1 { return set[0] }

        guard let detected = detectLanguage(for: wav, in: dir) else {
            logLine("language detect failed; falling back to \(set[0])")
            return set[0]
        }
        if set.contains(detected.code) {
            logLine("detected \(detected.code) (p=\(String(format: "%.2f", detected.p))) — in selection")
            return detected.code
        }
        logLine("detected \(detected.code), not in selection \(set) — using \(set[0])")
        return set[0]
    }

    private func detectLanguage(for wav: URL, in dir: URL) -> (code: String, p: Double)? {
        let proc = Process()
        proc.executableURL = dir.appendingPathComponent("whisper-cli")
        proc.arguments = ["-m", modelPath, "-f", wav.path, "-dl", "-t", "8"]
        var env = ProcessInfo.processInfo.environment
        env["DYLD_LIBRARY_PATH"] = dir.path
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        do { try proc.run() } catch { return nil }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        proc.waitUntilExit()

        // "whisper_full_with_state: auto-detected language: fr (p = 0.996621)"
        guard let r = out.range(of: "auto-detected language: ") else { return nil }
        let tail = out[r.upperBound...]
        let code = String(tail.prefix(while: { $0.isLetter || $0 == "-" }))
        guard !code.isEmpty else { return nil }
        var p = 0.0
        if let pr = tail.range(of: "p = ") {
            p = Double(tail[pr.upperBound...].prefix(while: { $0.isNumber || $0 == "." })) ?? 0
        }
        return (code, p)
    }

    private func writeWav(_ audio: [Float], to url: URL) -> Bool {
        var d = Data()
        let sr: UInt32 = 16_000, bytes = UInt32(audio.count * 2)
        func le<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append("RIFF".data(using: .ascii)!); le(UInt32(36 + bytes)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); le(UInt32(16)); le(UInt16(1)); le(UInt16(1))
        le(sr); le(sr * 2); le(UInt16(2)); le(UInt16(16))
        d.append("data".data(using: .ascii)!); le(bytes)
        for f in audio { le(Int16(max(-1, min(1, f)) * 32767)) }
        do { try d.write(to: url); return true } catch { return false }
    }

    func cancel() {
        running = false
        stopPartials()
        Ducker.restore()
        removeTap()
        samplesLock.lock(); samples.removeAll(); samplesLock.unlock()
        emit(["type": "cancelled"])
    }

    private func removeTap() {
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        engine.stop()
    }
}

/// Injects text into whatever app currently has keyboard focus by staging it
/// on the pasteboard and posting a synthetic Cmd+V, then restoring whatever
/// the user had on the pasteboard before.
enum Inserter {
    /// Set once we have shown the system prompt. Re-prompting on every failed
    /// insert is what made the app feel like it was asking forever.
    nonisolated(unsafe) static var didPrompt = false

    static func accessibilityTrusted(prompt: Bool) -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let shouldPrompt = prompt && !didPrompt
        if shouldPrompt { didPrompt = true }
        return AXIsProcessTrustedWithOptions([key: shouldPrompt] as CFDictionary)
    }

    static func insert(_ text: String) {
        guard !text.isEmpty else { return }
        guard accessibilityTrusted(prompt: !didPrompt) else {
            emit(["type": "error", "message": "Accessibility not granted - enable it, then relaunch Quill"])
            logLine("insert blocked: accessibility not granted")
            return
        }

        let pb = NSPasteboard.general
        let previous = pb.string(forType: .string)
        pb.clearContents()
        pb.setString(text, forType: .string)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            postCommandV()
            emit(["type": "inserted", "chars": text.count])
            if let previous {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                    pb.clearContents()
                    pb.setString(previous, forType: .string)
                }
            }
        }
    }

    private static func postCommandV() {
        let src = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 0x09   // ANSI 'v'
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: vKey, keyDown: false)
        else { return }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}


// MARK: - output ducking

/// Drops system output volume while recording so you can talk over whatever is
/// playing, then puts it back exactly where it was.
enum Ducker {
    nonisolated(unsafe) static var enabled = true
    /// Fraction of the original volume to duck to. 0 mutes outright.
    nonisolated(unsafe) static var level: Float = 0.15
    nonisolated(unsafe) private static var restoreTo: Float? = nil

    private static func defaultOutputDevice() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        let err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
        return err == noErr && id != 0 ? id : nil
    }

    private static func volumeAddress(_ device: AudioDeviceID) -> AudioObjectPropertyAddress? {
        // Most devices expose a main volume; some only expose per-channel.
        for element in [kAudioObjectPropertyElementMain, 1] {
            var addr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyVolumeScalar,
                mScope: kAudioDevicePropertyScopeOutput,
                mElement: AudioObjectPropertyElement(element))
            if AudioObjectHasProperty(device, &addr) { return addr }
        }
        return nil
    }

    private static func volume(_ device: AudioDeviceID, _ addr: inout AudioObjectPropertyAddress) -> Float? {
        var value: Float = 0
        var size = UInt32(MemoryLayout<Float>.size)
        let err = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value)
        return err == noErr ? value : nil
    }

    static func duck() {
        guard enabled, restoreTo == nil,
              let device = defaultOutputDevice(),
              var addr = volumeAddress(device),
              let current = volume(device, &addr) else { return }

        // Nothing audible playing, nothing to duck.
        guard current > 0.001 else { return }

        restoreTo = current
        var target = current * level
        let size = UInt32(MemoryLayout<Float>.size)
        if AudioObjectSetPropertyData(device, &addr, 0, nil, size, &target) == noErr {
            logLine(String(format: "ducked output %.0f%% -> %.0f%%", current * 100, target * 100))
        } else {
            restoreTo = nil
        }
    }

    static func restore() {
        guard var target = restoreTo,
              let device = defaultOutputDevice(),
              var addr = volumeAddress(device) else { restoreTo = nil; return }
        restoreTo = nil
        let size = UInt32(MemoryLayout<Float>.size)
        if AudioObjectSetPropertyData(device, &addr, 0, nil, size, &target) == noErr {
            logLine(String(format: "restored output to %.0f%%", target * 100))
        }
    }
}

// MARK: - fn hotkey

/// Watches the `fn` modifier via a CGEventTap and turns raw up/down into
/// gestures. Hold = push-to-talk; double-tap = latched toggle.
final class HotkeyMonitor {
    static let shared = HotkeyMonitor()

    var enabled = true
    var holdThreshold: TimeInterval = 0.30    // held longer than this = a hold
    var doubleTapWindow: TimeInterval = 0.35  // two downs inside this = double tap

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var fnWasDown = false
    private var lastDownAt: TimeInterval = 0
    private var pressStartedAt: TimeInterval = 0
    private var latched = false               // toggle mode is holding it open
    private var pendingRelease: DispatchWorkItem?
    /// True once another key is pressed while fn is held, which means the user
    /// wants fn+key (brightness, page-up, emoji) - not dictation.
    private var otherKeyDuringFn = false
    /// Swallow the standalone hold-key release so macOS never runs its default
    /// action (fn opens the globe/input-source switcher). Combos always pass through.
    var captureFn = true

    /// Which physical key is held to talk. Identified by keycode, so left and
    /// right modifiers are distinguishable — the flags alone cannot tell them apart.
    var holdKeycode: Int64 = 63          // fn
    private var lastFlags: CGEventFlags = []

    /// The modifier flag that a given key raises, used to tell press from release.
    private static func flag(for keycode: Int64) -> CGEventFlags {
        switch keycode {
        case 63:        return .maskSecondaryFn
        case 54, 55:    return .maskCommand
        case 58, 61:    return .maskAlternate
        case 59, 62:    return .maskControl
        case 56, 60:    return .maskShift
        case 57:        return .maskAlphaShift
        default:        return .maskSecondaryFn
        }
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// Polls for the Accessibility grant and installs the tap the moment it
    /// appears, so granting it does not require quitting the app.
    func watchForPermission() {
        guard tap == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.tap == nil else { return }
            if Inserter.accessibilityTrusted(prompt: false) {
                logLine("hotkey: accessibility appeared, installing tap")
                self.install()
            }
            self.watchForPermission()
        }
    }

    func install() {
        guard tap == nil else { return }
        // Ask outright the first time. Hold-to-talk and typing into other apps
        // both need this, and nothing else in the app will ever request it.
        guard Inserter.accessibilityTrusted(prompt: !Inserter.didPrompt) else {
            emit(["type": "hotkey-status", "installed": false, "reason": "accessibility"])
            logLine("hotkey: not installed, accessibility not granted (watching)")
            watchForPermission()
            return
        }
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
                 | CGEventMask(1 << CGEventType.keyDown.rawValue)
        guard let t = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,          // active: we may consume the fn release
            eventsOfInterest: mask,
            callback: { _, type, event, _ in
                let m = HotkeyMonitor.shared
                switch type {
                case .tapDisabledByTimeout, .tapDisabledByUserInput:
                    // The system disables slow taps; bring it back up.
                    m.reenable()
                case .keyDown:
                    m.noteOtherKey()
                case .flagsChanged:
                    // Only the configured key matters; every other modifier
                    // change passes straight through.
                    let code = event.getIntegerValueField(.keyboardEventKeycode)
                    if code == m.holdKeycode,
                       m.handle(fnDown: event.flags.contains(HotkeyMonitor.flag(for: code))) {
                        return nil   // consumed - macOS never sees the bare tap
                    }
                default: break
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: nil
        ) else {
            emit(["type": "hotkey-status", "installed": false, "reason": "tapCreate failed"])
            logLine("hotkey: tapCreate failed")
            return
        }
        tap = t
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        emit(["type": "hotkey-status", "installed": true])
        logLine("hotkey: fn tap installed")
    }

    func reenable() {
        guard let tap else { return }
        CGEvent.tapEnable(tap: tap, enable: true)
        logLine("hotkey: tap re-enabled after system disable")
    }

    /// Any non-modifier key while fn is held means this is a combo, not a
    /// dictation gesture, so the release must pass through untouched.
    func noteOtherKey() {
        if fnWasDown { otherKeyDuringFn = true }
    }

    /// Returns true when the event should be swallowed.
    func handle(fnDown: Bool) -> Bool {
        guard enabled, fnDown != fnWasDown else { return false }
        fnWasDown = fnDown

        if fnDown {
            otherKeyDuringFn = false
            onDown()
            // Pass the press through so fn+F1, fn+arrows etc. still work.
            return false
        }

        let standalone = !otherKeyDuringFn
        onUp()
        // Swallow only a standalone release: that is the one macOS would turn
        // into a language switch.
        if standalone && captureFn {
            logLine("hotkey: swallowed standalone fn release (no language switch)")
            return true
        }
        return false
    }

    private func onDown() {
        let t = now
        let isDoubleTap = (t - lastDownAt) < doubleTapWindow
        lastDownAt = t

        if isDoubleTap {
            // Second tap: latch it open. The first tap already started us.
            pendingRelease?.cancel(); pendingRelease = nil
            latched = true
            logLine("hotkey: double-tap -> latched toggle on")
            emit(["type": "hotkey", "intent": "start", "latched": true])
            return
        }
        if latched {
            // A single tap while latched turns it off.
            latched = false
            logLine("hotkey: tap while latched -> stop")
            emit(["type": "hotkey", "intent": "stop"])
            return
        }
        pressStartedAt = t
        logLine("hotkey: fn down -> start")
        emit(["type": "hotkey", "intent": "start", "latched": false])
    }

    private func onUp() {
        guard !latched else { return }   // toggle mode ignores release
        let held = now - pressStartedAt
        if held >= holdThreshold {
            logLine("hotkey: fn released after \(String(format: "%.2f", held))s -> stop")
            emit(["type": "hotkey", "intent": "stop"])
            return
        }
        // Too short to be a hold. It might be the first half of a double-tap,
        // so wait out the window before deciding it was just a stray tap.
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.latched else { return }
            logLine("hotkey: short tap, no second tap -> stop")
            emit(["type": "hotkey", "intent": "stop"])
        }
        pendingRelease = work
        DispatchQueue.main.asyncAfter(deadline: .now() + doubleTapWindow, execute: work)
    }
}

/// Set by the app from its settings; models live in Application Support, not
/// in the bundle, so only the one actually in use is ever downloaded.
nonisolated(unsafe) var modelPath = ""
/// Languages the user dictates in. One entry means whisper is told outright;
/// several means we detect first and snap the result to this set; "auto" means
/// let whisper pick from all 99.
nonisolated(unsafe) var languages = ["en"]

let recognizer = Recognizer()

emit(["type": "boot", "pid": Int(getpid())])

DispatchQueue.main.async { HotkeyMonitor.shared.install() }


DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        switch line.trimmingCharacters(in: .whitespaces) {
        case "start":  DispatchQueue.main.async { recognizer.start() }
        case "stop":   DispatchQueue.main.async { recognizer.stop() }
        case "cancel": DispatchQueue.main.async { recognizer.cancel() }
        case "quit":   exit(0)
        case "ax-check":
            emit(["type": "ax", "trusted": Inserter.accessibilityTrusted(prompt: false)])
        case "hotkey-install":
            DispatchQueue.main.async { HotkeyMonitor.shared.install() }
        case "hotkey-on":  HotkeyMonitor.shared.enabled = true
        case "hotkey-off": HotkeyMonitor.shared.enabled = false
        case "fn-capture-on":  HotkeyMonitor.shared.captureFn = true
        case "fn-capture-off": HotkeyMonitor.shared.captureFn = false
        default:
            // insert <base64> — base64 keeps newlines out of the line protocol.
            if line.hasPrefix("model ") {
                modelPath = String(line.dropFirst("model ".count)).trimmingCharacters(in: .whitespaces)
                logLine("model set to: \"\(modelPath)\"")
            }
            if line.hasPrefix("holdkey ") {
                let v = String(line.dropFirst("holdkey ".count)).trimmingCharacters(in: .whitespaces)
                if v == "off" {
                    HotkeyMonitor.shared.enabled = false
                    logLine("hold key: disabled")
                } else if let code = Int64(v) {
                    HotkeyMonitor.shared.enabled = true
                    HotkeyMonitor.shared.holdKeycode = code
                    logLine("hold key: keycode \(code)")
                }
            }
            if line.hasPrefix("duck ") {
                let v = String(line.dropFirst("duck ".count)).trimmingCharacters(in: .whitespaces)
                if v == "off" { Ducker.enabled = false }
                else if let pct = Float(v) {
                    Ducker.enabled = true
                    Ducker.level = max(0, min(1, pct / 100))
                }
                logLine("duck: enabled=\(Ducker.enabled) level=\(Ducker.level)")
            }
            if line.hasPrefix("lang ") {
                let raw = String(line.dropFirst("lang ".count)).trimmingCharacters(in: .whitespaces)
                languages = raw.split(separator: ",").map {
                    $0.trimmingCharacters(in: .whitespaces)
                }.filter { !$0.isEmpty }
                if languages.isEmpty { languages = ["auto"] }
                logLine("languages set to: \(languages.joined(separator: ", "))")
            }
            if line.hasPrefix("hold-ms ") {
                if let v = Double(line.dropFirst("hold-ms ".count)) {
                    HotkeyMonitor.shared.holdThreshold = v / 1000
                }
            }
            if line.hasPrefix("doubletap-ms ") {
                if let v = Double(line.dropFirst("doubletap-ms ".count)) {
                    HotkeyMonitor.shared.doubleTapWindow = v / 1000
                }
            }
            if line.hasPrefix("insert ") {
                let b64 = String(line.dropFirst("insert ".count))
                if let data = Data(base64Encoded: b64),
                   let text = String(data: data, encoding: .utf8) {
                    DispatchQueue.main.async { Inserter.insert(text) }
                }
            }
        }
    }
    exit(0)
}

RunLoop.main.run()
