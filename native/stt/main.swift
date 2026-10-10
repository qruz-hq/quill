// flow-stt, on-device speech recognition helper for the Flow clone.
// Protocol: newline-delimited JSON on stdout; bare commands on stdin.
//   stdin : start | stop | cancel | retry | quit | devices | mic <uid>|default
//   stdout: {"type":"boot"} {"type":"partial","text":…} {"type":"final","text":…}
//           {"type":"level","value":0.0–1.0} {"type":"error","message":…}
//           {"type":"devices","devices":[{id,uid,name,isDefault}],"pinned":…}
//           {"type":"interrupted"}, the mic vanished mid-recording; stop now

import Foundation
import AVFoundation
import Accelerate
import AppKit
import CoreGraphics
import CoreAudio
import AudioToolbox
import EventKit

let stdoutQueue = DispatchQueue(label: "stdout")

/// Everything the recogniser does, appended to a file. A Finder-launched app
/// has no visible stdout, so this is the only way to see what happened.
let logURL = URL(fileURLWithPath: NSHomeDirectory())
    .appendingPathComponent("Library/Logs/Quill-stt.log")

func logLine(_ text: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(text)\n"
    stdoutQueue.async {
        let data = Data(line.utf8)
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
/// One microphone, opened through a capture session and handed back as
/// 16 kHz mono floats, which is what whisper wants.
///
/// AVAudioEngine was used here before. Pointing its input node at a device
/// other than the system default left it with the wrong format: with the
/// built-in mic pinned and a Bluetooth headset as output it refused to start
/// (-10868), and installing a tap during the headset's profile switch raised
/// an Objective-C exception that killed the helper. A capture session takes a
/// device by UID and does the conversion itself.
final class MicCapture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ m: String) { errorDescription = m }
    }

    let name: String
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "studio.saudad.quill.mic")
    private let onSamples: (UnsafePointer<Float>, Int) -> Void
    private var observers: [NSObjectProtocol] = []
    private var scratch: [Float] = []
    private var stopped = false

    /// `uid` nil follows the system default. A pinned device that is not
    /// connected falls back to the default; the pin itself is kept by the caller.
    init(uid: String?,
         onSamples: @escaping (UnsafePointer<Float>, Int) -> Void,
         onLost: @escaping () -> Void) throws {
        var device = uid.flatMap { AVCaptureDevice(uniqueID: $0) }
        if let uid, device == nil { logLine("mic: pinned \(uid) not connected, using system default") }
        device = device ?? AVCaptureDevice.default(for: .audio)
        guard let device else {
            throw Failure("No microphone found. Connect one or pick another input in Settings.")
        }
        name = device.localizedName
        self.onSamples = onSamples
        super.init()

        guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            throw Failure("Could not open \(device.localizedName). Pick another input in Settings.")
        }
        session.addInput(input)

        let output = AVCaptureAudioDataOutput()
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else {
            throw Failure("Could not read audio from \(device.localizedName).")
        }
        session.addOutput(output)

        // Unplugged, or the session fell over: the owner decides what to do.
        let lost: (Notification) -> Void = { [weak self] _ in
            guard let self, !self.stopped else { return }
            onLost()
        }
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSNotification.Name.AVCaptureSessionRuntimeError,
                                            object: session, queue: .main, using: lost))
        observers.append(center.addObserver(forName: NSNotification.Name.AVCaptureDeviceWasDisconnected,
                                            object: device, queue: .main, using: lost))

        session.startRunning()
        guard session.isRunning else {
            stop()
            throw Failure("Could not open \(device.localizedName). Pick another input in Settings.")
        }
    }

    /// Lets go of the device. A Bluetooth headset only returns to its music
    /// profile once nothing holds its microphone.
    func stop() {
        stopped = true
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if session.isRunning { session.stopRunning() }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard !stopped, let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let count = CMBlockBufferGetDataLength(block) / MemoryLayout<Float>.size
        guard count > 0 else { return }
        if scratch.count < count { scratch = [Float](repeating: 0, count: count) }
        let status = scratch.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Float>.size,
                                       destination: $0.baseAddress!)
        }
        guard status == kCMBlockBufferNoErr else { return }
        scratch.withUnsafeBufferPointer { onSamples($0.baseAddress!, count) }
    }
}

/// Splits the microphone signal into bands from low to high pitch, for the
/// input meter in Settings. One per capture, used only on its audio queue.
final class Spectrum {
    static let bands = 28
    private let size = 512                     // 32 ms at 16 kHz
    private let log2n: vDSP_Length = 9
    private let setup: FFTSetup
    private var window: [Float]
    private var pending: [Float] = []
    private var edges: [Int] = []

    init() {
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        window = [Float](repeating: 0, count: size)
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_DENORM))
        // Evenly spaced by pitch, not by Hz: 90 Hz to 7.6 kHz covers a voice.
        let low = 90.0, high = 7_600.0
        edges = (0...Spectrum.bands).map { i in
            let hz = low * pow(high / low, Double(i) / Double(Spectrum.bands))
            return Int((hz * Double(size) / 16_000).rounded())
        }
        for i in 1..<edges.count where edges[i] <= edges[i - 1] { edges[i] = edges[i - 1] + 1 }
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    /// Returns one value per band, 0 to 1, each time a full frame has arrived.
    func feed(_ samples: UnsafePointer<Float>, _ count: Int) -> [Double]? {
        pending.append(contentsOf: UnsafeBufferPointer(start: samples, count: count))
        guard pending.count >= size else { return nil }
        var frame = Array(pending.suffix(size))
        pending.removeAll(keepingCapacity: true)
        vDSP_vmul(frame, 1, window, 1, &frame, 1, vDSP_Length(size))

        let half = size / 2
        var real = [Float](repeating: 0, count: half)
        var imag = [Float](repeating: 0, count: half)
        var power = [Float](repeating: 0, count: half)
        real.withUnsafeMutableBufferPointer { r in
            imag.withUnsafeMutableBufferPointer { i in
                var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                frame.withUnsafeBufferPointer { f in
                    f.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &power, 1, vDSP_Length(half))
            }
        }

        // A full-scale tone lands at 0 dB: the transform is doubled and the
        // window halves a tone's height, so its peak is `size / 2`.
        let reference = Float(size / 2) * Float(size / 2)
        return (0..<Spectrum.bands).map { band in
            let from = min(edges[band], half - 1)
            let to = min(max(edges[band + 1], from + 1), half)
            var peak: Float = 0
            for bin in from..<to { peak = max(peak, power[bin]) }
            let db = 10 * log10(max(peak / reference, 1e-12))
            return Double(max(0, min(1, (db + Spectrum.floorDB) / Spectrum.rangeDB)))
        }
    }

    /// A band at -62 dB is silent on the meter and one at -16 dB fills it, so
    /// room hum barely registers and a normal speaking voice fills the bars.
    static let floorDB: Float = 62
    static let rangeDB: Float = 46
}

final class Recognizer {
    /// Built fresh for every recording and dropped the moment it ends. A
    /// long-lived engine kept the tap and converter of whichever device was
    /// active when it was first used, so plugging in headphones left it
    /// recording silence or failing to start; holding it open also kept
    /// Bluetooth headsets stuck in their low-quality call profile.
    private var engine: MicCapture?
    private var samples: [Float] = []          // 16 kHz mono, whisper's native rate
    private let samplesLock = NSLock()
    private var running = false
    /// The last finished recording, kept in memory only so the bar's "Try again"
    /// can re-run it. Replaced by the next recording, dropped on cancel.
    private var lastAudio: [Float] = []
    /// Input device UID chosen in Settings, or nil to follow the system default.
    /// Kept while the device is unplugged so it is used again when it returns.
    var pinnedUID: String?
    /// Interim transcription while the user is still speaking, so the bar can
    /// show words appearing instead of a silent wait. Greedy decoding only:
    /// ~20x faster than the beam search used for the final pass.
    private var partialTimer: DispatchSourceTimer?
    private var partialInFlight = false
    private static let partialInterval: TimeInterval = 1.5

    /// Streaming mode ships audio as it arrives instead of transcribing here.
    private var sentSamples = 0
    private var chunkTimer: DispatchSourceTimer?
    /// Short, because OpenAI's live model answers per chunk: at 0.5 s its
    /// words arrived in bursts, at 0.2 s they arrive as they are spoken.
    private static let chunkInterval: TimeInterval = 0.2

    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: 16_000, channels: 1, interleaved: false)!

    /// Bundled next to the app binary: Contents/Resources/whisper/
    private lazy var whisperDir: URL = {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let contents = exe.deletingLastPathComponent()  // Contents/MacOS
                          .deletingLastPathComponent()  // Contents
        let bundled = contents.appendingPathComponent("Resources/whisper")
        // In development the helper runs from resources/FlowSTT.app, and
        // whisper sits beside that bundle in resources/whisper.
        let dev = contents.deletingLastPathComponent()  // FlowSTT.app
                          .deletingLastPathComponent()  // resources
                          .appendingPathComponent("whisper")
        let fm = FileManager.default
        for dir in [bundled, dev] where fm.isExecutableFile(atPath: dir.appendingPathComponent("whisper-cli").path) {
            return dir
        }
        logLine("whisper-cli not found in \(bundled.path) or \(dev.path)")
        return bundled
    }()

    func start() {
        // Running with no engine means a lost mic whose recording was never
        // stopped. Drop it so this start gets a clean attempt.
        if running && engine == nil {
            logLine("start: abandoning a recording whose microphone was lost")
            running = false
            stopPartials(); stopChunks(); Ducker.restore()
        }
        guard !running else { return }
        // A mic test must never hold the device while a dictation needs it.
        stopTest()
        // Whatever a previous recording left behind goes first, so a failure
        // last time can never poison this one.
        teardownEngine()
        samplesLock.lock(); samples.removeAll(); samplesLock.unlock()

        running = true
        do {
            try buildEngine()
        } catch {
            // Opening the mic is what makes a Bluetooth headset switch to its
            // call profile, and the first attempt often lands mid-switch. The
            // recording is kept alive while the device settles and is retried.
            teardownEngine()
            logLine("start: microphone not ready (\(error.localizedDescription)), retrying")
            rebuild(attempt: 1)
        }
        Ducker.duck()
        // Local partials burn CPU re-decoding the same audio; when the
        // cloud is already transcribing live there is nothing to add.
        if sttStreaming { startChunks() } else { startPartials() }
        emit(["type": "started"])
        logLine("=== recording started ===")
    }

    /// Opens the pinned device (or the system default) for this recording.
    private func buildEngine() throws {
        let spectrum = Spectrum()
        let capture = try MicCapture(
            uid: pinnedUID,
            onSamples: { [weak self] samples, count in
                self?.accumulate(samples, count)
                self?.emitLevel(samples, count)
                if let bands = spectrum.feed(samples, count) { emit(["type": "spectrum", "bands": bands]) }
            },
            // Unplugged or interrupted: the capture is dead, so it is rebuilt
            // on whatever device is there now.
            onLost: { [weak self] in self?.configurationChanged() })
        engine = capture
        logLine("mic: \(capture.name) · 16000 Hz · 1 ch")
    }

    // MARK: Mic test

    /// Its own capture, so a test never touches a recording's samples.
    private var testEngine: MicCapture?
    private var testTimeout: DispatchWorkItem?

    /// Opens the microphone for a few seconds and reports its level, then lets
    /// go. Short on purpose: an open mic keeps a Bluetooth headset in its
    /// low-quality call profile for as long as it is held.
    func startTest(seconds: Double) {
        stopTest(silent: true)
        guard !running else { emit(["type": "mic-test", "state": "ended"]); return }
        do {
            let spectrum = Spectrum()
            let capture = try MicCapture(
                uid: pinnedUID,
                onSamples: { [weak self] samples, count in
                    self?.emitLevel(samples, count, as: "mic-test-level")
                    if let bands = spectrum.feed(samples, count) { emit(["type": "spectrum", "bands": bands]) }
                },
                onLost: { [weak self] in self?.stopTest() })
            testEngine = capture
            emit(["type": "mic-test", "state": "started", "device": capture.name])
        } catch {
            emit(["type": "mic-test", "state": "ended", "error": error.localizedDescription]); return
        }
        let work = DispatchWorkItem { [weak self] in self?.stopTest() }
        testTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func stopTest(silent: Bool = false) {
        testTimeout?.cancel(); testTimeout = nil
        guard let capture = testEngine else { return }
        capture.stop()
        testEngine = nil
        if !silent { emit(["type": "mic-test", "state": "ended"]) }
    }

    /// Stops and drops the engine so macOS releases the device, a Bluetooth
    /// headset only returns to its music profile once nothing holds its mic.
    private func teardownEngine() {
        engine?.stop()
        engine = nil
    }

    /// Mid-recording device change. What was captured stays; capture carries
    /// on from the new device. If no device will open, the recording is ended
    /// with what it has instead of being thrown away.
    private func configurationChanged() {
        guard running else { teardownEngine(); return }
        logLine("mic: configuration changed mid-recording, rebuilding")
        teardownEngine()
        rebuild(attempt: 1)
    }

    /// A device that has just been plugged in, unplugged or switched profile
    /// reports nonsense for a moment, so it is given time to settle and a few
    /// tries before the recording is ended with what it already has.
    private func rebuild(attempt: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self, self.running, self.engine == nil else { return }
            do {
                try self.buildEngine()
            } catch {
                self.teardownEngine()
                if attempt < 6 { self.rebuild(attempt: attempt + 1); return }
                self.samplesLock.lock(); let empty = self.samples.isEmpty; self.samplesLock.unlock()
                if empty {
                    // It never opened: there is nothing to finish, so say why.
                    logLine("mic: could not open (\(error.localizedDescription))")
                    self.running = false
                    self.stopPartials(); self.stopChunks(); Ducker.restore()
                    // Its own event, not `error`: the app has to end this
                    // recording, and must not guess that from an error that
                    // may belong to a dictation still being transcribed.
                    emit(["type": "start-failed", "message": "Could not open the microphone. Check the input in Settings and try again."])
                    return
                }
                logLine("mic: rebuild failed (\(error.localizedDescription)), finishing with what was recorded")
                emit(["type": "interrupted"])
            }
        }
    }

    /// The capture already delivers 16 kHz mono; keep it.
    private func accumulate(_ samples: UnsafePointer<Float>, _ count: Int) {
        samplesLock.lock()
        self.samples.append(contentsOf: UnsafeBufferPointer(start: samples, count: count))
        samplesLock.unlock()
    }

    private func emitLevel(_ samples: UnsafePointer<Float>, _ count: Int, as type: String = "level") {
        guard count > 0 else { return }
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let db = 20 * log10(max(sqrt(sum / Float(count)), 1e-7))
        let norm = (db + 55) / 55
        emit(["type": type, "value": Double(max(0, min(1, norm)))])
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

    private func startChunks() {
        sentSamples = 0
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + Recognizer.chunkInterval,
                       repeating: Recognizer.chunkInterval)
        timer.setEventHandler { [weak self] in
            guard let self, self.running else { return }
            self.flushChunk()
        }
        timer.resume()
        chunkTimer = timer
    }

    private func stopChunks() {
        chunkTimer?.cancel()
        chunkTimer = nil
    }

    /// Emits everything captured since the last flush as base64 PCM16.
    private func flushChunk() {
        samplesLock.lock()
        let slice = sentSamples < samples.count ? Array(samples[sentSamples...]) : []
        sentSamples = samples.count
        samplesLock.unlock()
        guard !slice.isEmpty else { return }

        var pcm = Data(capacity: slice.count * 2)
        for f in slice {
            var s = Int16(max(-1, min(1, f)) * 32767)
            withUnsafeBytes(of: &s) { pcm.append(contentsOf: $0) }
        }
        emit(["type": "chunk", "b64": pcm.base64EncodedString()])
    }

    private func stopPartials() {
        partialTimer?.cancel()
        partialTimer = nil
    }

    /// Every `final` (and `audio`) carries the id of the stop or retry it
    /// answers, so two dictations finishing out of order cannot swap results.
    /// A failure travels in the same message, never as a separate `error`.
    private func emitFinal(_ id: String, _ text: String, error: String? = nil) {
        var payload: [String: Any] = ["type": "final", "id": id, "text": text]
        if let error { payload["error"] = error }
        emit(payload)
    }

    func stop(id: String) {
        guard running else { teardownEngine(); emitFinal(id, ""); return }
        running = false
        stopPartials()
        Ducker.restore()
        teardownEngine()
        if sttStreaming { stopChunks(); flushChunk() } else { stopChunks() }

        samplesLock.lock(); let audio = samples; samples.removeAll(); samplesLock.unlock()
        lastAudio = audio
        process(audio, id)
    }

    /// Re-runs the last recording through the same path a fresh stop takes.
    func retry(id: String) {
        guard !running, !lastAudio.isEmpty else {
            logLine("retry: no recording kept")
            emitFinal(id, "")
            return
        }
        logLine("=== retrying last recording ===")
        process(lastAudio, id)
    }

    private func process(_ audio: [Float], _ id: String) {
        let seconds = Double(audio.count) / 16_000

        // A mic-denied app is handed digital silence, not an error, so the only
        // way to tell "permission missing" from "you said nothing" is the signal.
        var peak: Float = 0
        for v in audio { peak = max(peak, abs(v)) }
        logLine("=== recording stopped (\(String(format: "%.1f", seconds))s, peak \(String(format: "%.4f", peak))) ===")

        if peak < 0.0005 && seconds > 0.5 {
            logLine("audio is digital silence, microphone permission is almost certainly missing")
            emitFinal(id, "", error: "No audio from the microphone. Allow Quill under Privacy & Security > Microphone.")
            return
        }

        // Too short to contain speech.
        guard seconds > 0.3 else { emitFinal(id, ""); return }

        // Cloud mode: write the WAV and hand it over. The app uploads it and
        // can ask us to transcribe the same file locally if that fails, so the
        // recording is never lost to a network problem. Checked before the
        // local model: the cloud needs none.
        if sttEngine == "cloud" {
            emit(["type": "transcribing"])
            let wav = FileManager.default.temporaryDirectory
                .appendingPathComponent("quill-\(UUID().uuidString).wav")
            if writeWav(audio, to: wav) {
                logLine("cloud mode: wrote \(String(format: "%.1f", seconds))s to \(wav.lastPathComponent)")
                emit(["type": "audio", "id": id, "path": wav.path, "seconds": seconds])
            } else {
                emitFinal(id, "", error: "Could not save the recording for upload.")
            }
            return
        }

        guard hasModel else {
            emitFinal(id, "", error: "No speech model installed. Pick one in Settings.")
            logLine("transcribe aborted: no model at \"\(modelPath)\"")
            return
        }
        emit(["type": "transcribing"])

        Task.detached { [weak self] in
            guard let self else { return }
            let text = self.transcribe(audio) ?? ""
            logLine("whisper: \"\(text)\"")
            self.emitFinal(id, text)
        }
    }

    private var hasModel: Bool {
        !modelPath.isEmpty && FileManager.default.fileExists(atPath: modelPath)
    }

    /// The cloud upload failed and the app wants the same file done locally.
    func fallback(id: String, path: String) {
        guard hasModel else {
            logLine("local fallback: no model installed")
            emitFinal(id, "", error: "Cloud transcription failed and no speech model is installed to fall back on.")
            return
        }
        let text = transcribeExisting(path) ?? ""
        logLine("local fallback: \"\(text)\"")
        emitFinal(id, text)
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
    /// detection pass and snap the answer to the chosen set, unconstrained
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
            logLine("detected \(detected.code) (p=\(String(format: "%.2f", detected.p))), in selection")
            return detected.code
        }
        logLine("detected \(detected.code), not in selection \(set), using \(set[0])")
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

    /// Runs whisper over a WAV already on disk, used when a cloud upload fails.
    func transcribeExisting(_ path: String) -> String? {
        guard !modelPath.isEmpty, FileManager.default.fileExists(atPath: modelPath) else { return nil }
        let dir = whisperDir
        let proc = Process()
        proc.executableURL = dir.appendingPathComponent("whisper-cli")
        proc.arguments = ["-m", modelPath, "-f", path, "-nt", "--no-prints", "-t", "8",
                          "-l", languages.first ?? "auto"]
        var env = ProcessInfo.processInfo.environment
        env["DYLD_LIBRARY_PATH"] = dir.path
        proc.environment = env
        let pipe = Pipe(); proc.standardOutput = pipe; proc.standardError = Pipe()
        do { try proc.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "")
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("[") }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func writeWav(_ audio: [Float], to url: URL) -> Bool {
        var d = Data()
        let sr: UInt32 = 16_000, bytes = UInt32(audio.count * 2)
        func le<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(Data("RIFF".utf8)); le(UInt32(36 + bytes)); d.append(Data("WAVE".utf8))
        d.append(Data("fmt ".utf8)); le(UInt32(16)); le(UInt16(1)); le(UInt16(1))
        le(sr); le(sr * 2); le(UInt16(2)); le(UInt16(16))
        d.append(Data("data".utf8)); le(bytes)
        for f in audio { le(Int16(max(-1, min(1, f)) * 32767)) }
        do { try d.write(to: url); return true } catch { return false }
    }

    func cancel() {
        running = false
        stopPartials()
        stopChunks()
        Ducker.restore()
        teardownEngine()
        samplesLock.lock(); samples.removeAll(); samplesLock.unlock()
        lastAudio.removeAll()
        emit(["type": "cancelled"])
    }
}

// MARK: - input devices

/// CoreAudio's view of the microphones, for the Settings picker and for
/// resolving a pinned device by UID (IDs change across reconnects; UIDs do not).
enum AudioDevices {
    private static let system = AudioObjectID(kAudioObjectSystemObject)

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func defaultInput() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = address(kAudioHardwarePropertyDefaultInputDevice)
        let err = AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &id)
        return err == noErr && id != 0 ? id : nil
    }

    private static func allDevices() -> [AudioDeviceID] {
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &value) == noErr,
              let cf = value?.takeRetainedValue() else { return nil }
        return cf as String
    }

    private static func inputChannels(_ id: AudioDeviceID) -> Int {
        var addr = address(kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    static func inputs() -> [(id: AudioDeviceID, uid: String, name: String)] {
        allDevices().compactMap { id in
            guard inputChannels(id) > 0, let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
            return (id, uid, string(id, kAudioObjectPropertyName) ?? uid)
        }
    }

    static func inputID(forUID uid: String) -> AudioDeviceID? {
        inputs().first { $0.uid == uid }?.id
    }

    /// Name of the device an engine's input node is actually bound to.
    static func currentInputName(of input: AVAudioInputNode) -> String? {
        guard let unit = input.audioUnit else { return nil }
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                   kAudioUnitScope_Global, 0, &id, &size) == noErr, id != 0 else { return nil }
        return string(id, kAudioObjectPropertyName)
    }

    static func emitList() {
        let def = defaultInput()
        let list: [[String: Any]] = inputs().map {
            ["id": Int($0.id), "uid": $0.uid, "name": $0.name, "isDefault": $0.id == def]
        }
        emit(["type": "devices", "devices": list, "pinned": recognizer.pinnedUID ?? ""])
    }

    /// Hot-plug and default-input changes. Coalesced: one plug fires several.
    nonisolated(unsafe) private static var pending: DispatchWorkItem?
    static func watch() {
        let changed: AudioObjectPropertyListenerBlock = { _, _ in
            pending?.cancel()
            let work = DispatchWorkItem {
                emitList()
                // Headphones that dropped out while ducked may be back.
                Ducker.retryOrphans()
            }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
        }
        for selector in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
            var addr = address(selector)
            AudioObjectAddPropertyListenerBlock(system, &addr, .main, changed)
        }
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
        guard accessibilityTrusted(prompt: false) else {
            emit(["type": "error", "message": "Quill needs Accessibility to type for you. Allow it from the Quill window; no relaunch needed."])
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

    /// Every volume control the device has: the main one when it exists,
    /// otherwise each channel. Bluetooth headsets only expose per-channel
    /// volume, and ducking just the first of them left one ear quiet.
    private static func volumeElements(_ device: AudioDeviceID) -> [AudioObjectPropertyElement] {
        func has(_ element: AudioObjectPropertyElement) -> Bool {
            var addr = address(element)
            return AudioObjectHasProperty(device, &addr)
        }
        if has(kAudioObjectPropertyElementMain) { return [kAudioObjectPropertyElementMain] }
        return (1...8).map { AudioObjectPropertyElement($0) }.filter(has)
    }

    private static func address(_ element: AudioObjectPropertyElement) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                   mScope: kAudioDevicePropertyScopeOutput,
                                   mElement: element)
    }

    private static func volume(_ device: AudioDeviceID, _ element: AudioObjectPropertyElement) -> Float? {
        var addr = address(element)
        var value: Float = 0
        var size = UInt32(MemoryLayout<Float>.size)
        let err = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value)
        return err == noErr ? value : nil
    }

    @discardableResult
    private static func setVolume(_ device: AudioDeviceID, _ element: AudioObjectPropertyElement, _ value: Float) -> Bool {
        var addr = address(element)
        var v = value
        return AudioObjectSetPropertyData(device, &addr, 0, nil, UInt32(MemoryLayout<Float>.size), &v) == noErr
    }

    private static func uid(of device: AudioDeviceID) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let err = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &value)
        guard err == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func device(forUID wanted: String) -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return nil }
        return ids.first { uid(of: $0) == wanted }
    }

    /// What was changed, so it is put back on the same device even if the
    /// default output moves while ducked (a headset switching profile does).
    private struct Ducked: Codable { var uid: String; var volumes: [UInt32: Float] }
    nonisolated(unsafe) private static var ducked: Ducked?
    /// Ducks whose device was gone when it was time to restore (headphones
    /// that dropped out mid-recording). Kept, in memory and on disk, and put
    /// back when the device returns, so it does not come back quiet.
    nonisolated(unsafe) private static var orphans: [Ducked] = []

    /// Everything not yet restored, kept on disk. If the helper dies first,
    /// the next launch reads it and puts the volume back.
    private static let stateURL = logURL.deletingLastPathComponent().appendingPathComponent("Quill-duck.json")

    private static func persist() {
        let all = orphans + (ducked.map { [$0] } ?? [])
        if all.isEmpty { try? FileManager.default.removeItem(at: stateURL); return }
        try? JSONEncoder().encode(all).write(to: stateURL, options: .atomic)
    }

    static func duck() {
        // A device that came back still ducked is put right before it is read.
        retryOrphans()
        guard enabled, ducked == nil,
              let device = defaultOutputDevice(),
              let uid = uid(of: device) else { return }
        var volumes: [UInt32: Float] = [:]
        for element in volumeElements(device) {
            if let v = volume(device, element) { volumes[element] = v }
        }
        // Nothing audible playing, nothing to duck.
        guard let loudest = volumes.values.max(), loudest > 0.001 else { return }

        ducked = Ducked(uid: uid, volumes: volumes)
        persist()
        for (element, v) in volumes { setVolume(device, element, v * level) }
        logLine(String(format: "ducked output %.0f%% -> %.0f%% on %d control(s)", loudest * 100, loudest * level * 100, volumes.count))
    }

    static func restore() {
        guard let state = ducked else { return }
        ducked = nil
        if !apply(state) {
            logLine("ducked device is gone, will restore its volume when it returns")
            orphans.removeAll { $0.uid == state.uid }
            orphans.append(state)
        }
        persist()
    }

    /// Called when the device list changes, and before each duck.
    static func retryOrphans() {
        guard !orphans.isEmpty else { return }
        orphans.removeAll { apply($0) }
        persist()
    }

    /// Run once at launch: undoes a duck that a crash left behind.
    static func recover() {
        guard let data = try? Data(contentsOf: stateURL) else { return }
        // Older builds wrote a single state, not a list.
        let saved = (try? JSONDecoder().decode([Ducked].self, from: data))
            ?? (try? JSONDecoder().decode(Ducked.self, from: data)).map { [$0] } ?? []
        if !saved.isEmpty { logLine("restoring output volume left ducked by a previous run") }
        orphans = saved.filter { !apply($0) }
        persist()
    }

    /// False when the device is not connected, so nothing could be put back.
    private static func apply(_ state: Ducked) -> Bool {
        guard let device = device(forUID: state.uid) else { return false }
        for (element, v) in state.volumes { setVolume(device, element, v) }
        if let loudest = state.volumes.values.max() {
            logLine(String(format: "restored output to %.0f%%", loudest * 100))
        }
        return true
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
    /// The current press sent a plain (unlatched) start.
    private var startedThisPress = false
    /// True once another key is pressed while fn is held, which means the user
    /// wants fn+key (brightness, page-up, emoji) - not dictation.
    private var otherKeyDuringFn = false
    /// Swallow the standalone hold-key release so macOS never runs its default
    /// action (fn opens the globe/input-source switcher). Combos always pass through.
    var captureFn = true

    /// Which physical key is held to talk. Identified by keycode, so left and
    /// right modifiers are distinguishable, the flags alone cannot tell them apart.
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
        // One loop at a time: install() can call back in here on failure.
        guard tap == nil, !watching else { return }
        watching = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.watching = false
            guard self.tap == nil else { return }
            if Inserter.accessibilityTrusted(prompt: false) {
                logLine("hotkey: accessibility appeared, installing tap")
                self.install()
            }
            self.watchForPermission()
        }
    }
    private var watching = false

    func install() {
        guard tap == nil else { return }
        // Never prompts: the app's onboarding asks, after explaining why. A
        // system dialog at launch, before any window, read as unexplained.
        guard Inserter.accessibilityTrusted(prompt: false) else {
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
            logLine("hotkey: tapCreate failed (retrying)")
            // Right after a grant the tap can still be refused for a moment;
            // the watch keeps trying until it takes.
            watchForPermission()
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
        guard fnWasDown, !otherKeyDuringFn else { return }
        otherKeyDuringFn = true
        // This press already started a recording. It was never a dictation,
        // so drop it now rather than transcribing a keyboard shortcut.
        if startedThisPress && !latched {
            startedThisPress = false
            pendingRelease?.cancel(); pendingRelease = nil
            logLine("hotkey: other key during fn -> cancel")
            emit(["type": "hotkey", "intent": "cancel"])
        }
    }

    /// The app ended a latched recording another way (Esc, its shortcut, the
    /// tray, a lost mic). Without this the next press would be spent on
    /// turning the latch off instead of starting a recording.
    func unlatch() {
        guard latched else { return }
        latched = false
        logLine("hotkey: unlatched by the app")
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
        if standalone { onUp() }
        // Swallow only a standalone release: that is the one macOS would turn
        // into a language switch.
        if standalone && captureFn {
            logLine("hotkey: swallowed standalone fn release (no language switch)")
            return true
        }
        return false
    }

    private func onDown() {
        // Whatever the last release was waiting to decide, this press decides it.
        pendingRelease?.cancel(); pendingRelease = nil
        startedThisPress = false
        let t = now
        let isDoubleTap = (t - lastDownAt) < doubleTapWindow
        lastDownAt = t

        if isDoubleTap {
            // Second tap: latch it open. The first tap already started us.
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
        startedThisPress = true
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
        // A lone quick tap was never a dictation: cancel, do not transcribe.
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.latched else { return }
            logLine("hotkey: short tap, no second tap -> cancel")
            emit(["type": "hotkey", "intent": "cancel"])
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
/// "local" runs whisper here; "cloud" hands the audio file to the app to upload.
/// Todos -> Calendar.app, through EventKit.
///
/// Lives in the helper because Electron cannot call EventKit and a native
/// Node module would mean a second toolchain. Every command carries an `id`
/// and answers with `{"type":"cal","id":…}` so the app can await it.
///
/// Full access rather than write-only on purpose: write-only cannot fetch an
/// event by identifier afterwards, so every edit would create a duplicate.
enum Calendar {
    static let store = EKEventStore()

    static var status: String {
        switch EKEventStore.authorizationStatus(for: .event) {
        case .fullAccess:  return "granted"
        case .writeOnly:   return "writeOnly"
        case .denied, .restricted: return "denied"
        default:           return "notDetermined"
        }
    }

    static func reply(_ id: String, _ extra: [String: Any]) {
        var p: [String: Any] = ["type": "cal", "id": id]
        for (k, v) in extra { p[k] = v }
        emit(p)
    }

    static func request(_ id: String) {
        store.requestFullAccessToEvents { ok, err in
            logLine("calendar: access \(ok ? "granted" : "refused")\(err.map { " (\($0.localizedDescription))" } ?? "")")
            reply(id, ["status": status])
        }
    }

    static func calendars(_ id: String) {
        guard status == "granted" else { reply(id, ["error": "no access", "status": status]); return }
        let def = store.defaultCalendarForNewEvents?.calendarIdentifier ?? ""
        let list: [[String: Any]] = store.calendars(for: .event)
            .filter { $0.allowsContentModifications }
            .map { ["id": $0.calendarIdentifier, "title": $0.title,
                    "source": $0.source.title, "color": $0.color.map { hex($0) } ?? "",
                    "isDefault": $0.calendarIdentifier == def] }
        reply(id, ["calendars": list])
    }

    /// Creates or updates. `date` is YYYY-MM-DD, `time` HH:MM or empty for all-day.
    static func upsert(_ id: String, _ a: [String: Any]) {
        guard status == "granted" else { reply(id, ["error": "no access", "status": status]); return }
        let title = a["title"] as? String ?? ""
        let date = a["date"] as? String ?? ""
        let time = a["time"] as? String ?? ""
        let notes = a["notes"] as? String ?? ""
        let minutes = a["minutes"] as? Int ?? 30
        let calId = a["calendarId"] as? String ?? ""
        let eventId = a["eventId"] as? String ?? ""

        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { reply(id, ["error": "bad date"]); return }
        var comps = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        let allDay = time.isEmpty
        if !allDay {
            let hm = time.split(separator: ":").compactMap { Int($0) }
            guard hm.count == 2 else { reply(id, ["error": "bad time"]); return }
            comps.hour = hm[0]; comps.minute = hm[1]
        }
        guard let start = Foundation.Calendar.current.date(from: comps) else { reply(id, ["error": "bad date"]); return }

        let event = (eventId.isEmpty ? nil : store.event(withIdentifier: eventId)) ?? EKEvent(eventStore: store)
        event.title = title
        event.notes = notes.isEmpty ? nil : notes
        event.isAllDay = allDay
        event.startDate = start
        event.endDate = allDay ? start : start.addingTimeInterval(TimeInterval(minutes * 60))
        // An existing event keeps its calendar unless the app asked to move it.
        if event.calendar == nil || (!calId.isEmpty && event.calendar.calendarIdentifier != calId) {
            event.calendar = store.calendars(for: .event).first { $0.calendarIdentifier == calId }
                ?? store.defaultCalendarForNewEvents
        }
        // No alarm: the user chose to keep the calendar quiet.
        event.alarms = nil
        do {
            try store.save(event, span: .thisEvent, commit: true)
            reply(id, ["eventId": event.eventIdentifier ?? "", "calendarId": event.calendar.calendarIdentifier])
        } catch {
            reply(id, ["error": error.localizedDescription])
        }
    }

    static func delete(_ id: String, _ eventId: String) {
        guard status == "granted" else { reply(id, ["error": "no access", "status": status]); return }
        guard let event = store.event(withIdentifier: eventId) else { reply(id, ["gone": true]); return }
        do { try store.remove(event, span: .thisEvent, commit: true); reply(id, ["gone": true]) }
        catch { reply(id, ["error": error.localizedDescription]) }
    }

    private static func hex(_ color: NSColor) -> String {
        guard let c = color.usingColorSpace(.sRGB) else { return "" }
        return String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}

/// Named sttEngine because Recognizer already has an `engine` (the AVAudioEngine).
nonisolated(unsafe) var sttEngine = "local"
/// Ship PCM to the app while recording so the upload finishes with the speech.
nonisolated(unsafe) var sttStreaming = false

let recognizer = Recognizer()
// A previous run that died while ducked left the volume down; put it back.
Ducker.recover()
// An uncaught Objective-C exception still ends the process, but not with the
// user's volume left ducked.
NSSetUncaughtExceptionHandler { _ in Ducker.restore() }

/// Every way out puts the user's volume back first.
func quit() -> Never {
    Ducker.restore()
    exit(0)
}
// The app asks with `quit` and only then signals, but a signal can still be
// the first thing to arrive (the app itself being killed, a logout).
nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { logLine("signal \(sig), quitting"); quit() }
    source.resume()
    signalSources.append(source)
}

emit(["type": "boot", "pid": Int(getpid())])

DispatchQueue.main.async { HotkeyMonitor.shared.install() }
DispatchQueue.main.async { AudioDevices.watch(); AudioDevices.emitList() }


DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        // `stop <id>` and `retry <id>`: the id comes back on the `final`.
        let words = line.split(separator: " ", maxSplits: 1).map(String.init)
        if words.count == 2, words[0] == "stop" || words[0] == "retry" {
            let id = words[1].trimmingCharacters(in: .whitespaces)
            DispatchQueue.main.async { words[0] == "stop" ? recognizer.stop(id: id) : recognizer.retry(id: id) }
            continue
        }
        switch line.trimmingCharacters(in: .whitespaces) {
        case "start":  DispatchQueue.main.async { recognizer.start() }
        case "stop":   DispatchQueue.main.async { recognizer.stop(id: "") }
        case "cancel": DispatchQueue.main.async { recognizer.cancel() }
        case "retry":  DispatchQueue.main.async { recognizer.retry(id: "") }
        case "unlatch": DispatchQueue.main.async { HotkeyMonitor.shared.unlatch() }
        case "quit":   quit()
        case "devices": DispatchQueue.main.async { AudioDevices.emitList() }
        case "mic-test": DispatchQueue.main.async { recognizer.startTest(seconds: 6) }
        case "mic-test-stop": DispatchQueue.main.async { recognizer.stopTest() }
        case "ax-check":
            // The app sends this when it sees the grant appear, so the hold key
            // comes up straight away rather than on the next 2s watch tick.
            let trusted = Inserter.accessibilityTrusted(prompt: false)
            emit(["type": "ax", "trusted": trusted])
            if trusted { DispatchQueue.main.async { HotkeyMonitor.shared.install() } }
        case "hotkey-install":
            DispatchQueue.main.async { HotkeyMonitor.shared.install() }
        case "hotkey-on":  HotkeyMonitor.shared.enabled = true
        case "hotkey-off": HotkeyMonitor.shared.enabled = false
        case "fn-capture-on":  HotkeyMonitor.shared.captureFn = true
        case "fn-capture-off": HotkeyMonitor.shared.captureFn = false
        default:
            // insert <base64>, base64 keeps newlines out of the line protocol.
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
            if line.hasPrefix("mic ") {
                let v = String(line.dropFirst("mic ".count)).trimmingCharacters(in: .whitespaces)
                DispatchQueue.main.async {
                    // Takes effect from the next recording; one in progress keeps its device.
                    recognizer.pinnedUID = (v.isEmpty || v == "default") ? nil : v
                    logLine("mic: \(recognizer.pinnedUID ?? "system default")")
                    AudioDevices.emitList()
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
            if line.hasPrefix("engine ") {
                sttEngine = String(line.dropFirst("engine ".count)).trimmingCharacters(in: .whitespaces)
                logLine("engine: \(sttEngine)")
                continue
            }
            if line.hasPrefix("stream ") {
                sttStreaming = line.hasSuffix("on")
                logLine("streaming: \(sttStreaming)")
            }
            // transcribe-file <id> <path>
            if line.hasPrefix("transcribe-file ") {
                let rest = line.dropFirst("transcribe-file ".count).split(separator: " ", maxSplits: 1).map(String.init)
                if rest.count == 2 {
                    let path = rest[1].trimmingCharacters(in: .whitespaces)
                    DispatchQueue.global(qos: .userInitiated).async { recognizer.fallback(id: rest[0], path: path) }
                }
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
            if line.hasPrefix("cal ") {
                let json = String(line.dropFirst("cal ".count))
                if let a = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
                   let id = a["id"] as? String, let op = a["op"] as? String {
                    switch op {
                    case "status":    Calendar.reply(id, ["status": Calendar.status])
                    case "request":   Calendar.request(id)
                    case "calendars": Calendar.calendars(id)
                    case "upsert":    Calendar.upsert(id, a)
                    case "delete":    Calendar.delete(id, a["eventId"] as? String ?? "")
                    default:          Calendar.reply(id, ["error": "unknown op \(op)"])
                    }
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
    // stdin closed: the app is gone.
    quit()
}

RunLoop.main.run()
